import {basename} from 'node:path';
import process from 'node:process';
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

const atuinAuthor = 'pi';
const atuinTimeout = 10_000;

type PendingHistory = {
  cwd: string;
  id: string;
};

type UserBashResult = {
  command: string;
  cwd: string;
  exitCode: number;
};

/**
Starts an Atuin history entry without making Atuin a prerequisite for command
execution. An unavailable or unconfigured Atuin installation is treated as an
optional integration failure, while a non-empty ID is retained for completion.
*/
async function startHistory(pi: ExtensionAPI, cwd: string, command: string): Promise<PendingHistory | undefined> {
  try {
    const result = await pi.exec('atuin', [
      'history',
      'start',
      '--author',
      atuinAuthor,
      '--author-kind',
      'agent',
      '--',
      command,
    ], {cwd, timeout: atuinTimeout});
    const id = result.stdout.trim();

    return result.code === 0 && id.length > 0 ? {cwd, id} : undefined;
  } catch {
    return undefined;
  }
}

/**
Completes a previously started history entry with the command's actual exit
status. Recording errors are deliberately swallowed because shell history must
never turn a successful user or agent command into a failed one.
*/
async function endHistory(pi: ExtensionAPI, history: PendingHistory, exitCode: number): Promise<void> {
  try {
    await pi.exec('atuin', [
      'history',
      'end',
      history.id,
      '--exit',
      String(exitCode),
    ], {cwd: history.cwd, timeout: atuinTimeout});
  } catch {
    // Atuin is an optional recorder; command execution has already completed.
  }
}

/**
Recovers the exit status encoded in Pi's Bash tool result. The Bash tool marks
non-zero exits as errors and appends a status line, while aborts and timeouts
need conventional shell codes so Atuin can distinguish those outcomes.
*/
function exitCodeFromToolResult(result: unknown, isError: boolean): number {
  if (!isError) {
    return 0;
  }

  if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content)) {
    return 1;
  }

  const text = result.content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null || !('text' in part)) {
      return '';
    }

    return typeof part.text === 'string' ? part.text : '';
  }).join('\n');
  const exited = /Command exited with code (?<code>\d+)\s*$/v.exec(text);

  if (exited?.groups?.code !== undefined) {
    return Number(exited.groups.code);
  }

  return /Command aborted\s*$/v.test(text)
    ? 130
    : (/Command timed out after \S+ seconds\s*$/v.test(text) ? 124 : 1);
}

/**
Validates the private completion event emitted by Sloppi's zsh wrapper. Custom
event payloads are untyped at the extension boundary, so malformed events are
ignored rather than risking an incorrect history update.
*/
function isUserBashResult(value: unknown): value is UserBashResult {
  return typeof value === 'object'
    && value !== null
    && 'command' in value
    && typeof value.command === 'string'
    && 'cwd' in value
    && typeof value.cwd === 'string'
    && 'exitCode' in value
    && typeof value.exitCode === 'number';
}

/**
Records both model-issued Bash tool calls and user-entered `!`/`!!` commands in
Atuin. Tool calls are observed without replacing the active Bash tool. User
commands under zsh are completed by Sloppi's existing wrapper; other shells are
wrapped here because Pi does not expose a user-Bash completion lifecycle event.
*/
export default function atuin(pi: ExtensionAPI): void {
  const pendingTools = new Map<string, PendingHistory>();
  const pendingUserCommands = new Map<string, PendingHistory[]>();

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') {
      return;
    }

    const {input} = event;
    if (typeof input !== 'object' || input === null || !('command' in input) || typeof input.command !== 'string' || input.command.length === 0) {
      return;
    }

    const history = await startHistory(pi, ctx.cwd, input.command);
    if (history !== undefined) {
      pendingTools.set(event.toolCallId, history);
    }
  });

  pi.on('tool_execution_end', async event => {
    const history = pendingTools.get(event.toolCallId);
    if (history === undefined) {
      return;
    }

    pendingTools.delete(event.toolCallId);
    await endHistory(pi, history, exitCodeFromToolResult(event.result, event.isError));
  });

  pi.on('user_bash', async event => {
    if (event.command.length === 0) {
      return;
    }

    const history = await startHistory(pi, event.cwd, event.command);
    if (history === undefined) {
      return;
    }

    const userShell = process.env.SHELL;
    if (userShell !== undefined && basename(userShell) === 'zsh') {
      const commands = pendingUserCommands.get(event.command) ?? [];
      commands.push(history);
      pendingUserCommands.set(event.command, commands);
      return;
    }

    const local = createLocalBashOperations(userShell === undefined ? undefined : {shellPath: userShell});
    return {
      operations: {
        async exec(command, cwd, options) {
          try {
            const result = await local.exec(command, cwd, options);
            await endHistory(pi, history, result.exitCode ?? 1);
            return result;
          } catch (error) {
            await endHistory(pi, history, 1);
            throw error;
          }
        },
      },
    };
  });

  pi.events.on('sloppi:user-bash-result', value => {
    if (!isUserBashResult(value)) {
      return;
    }

    const commands = pendingUserCommands.get(value.command);
    if (commands === undefined) {
      return;
    }

    const history = commands.shift();
    if (history === undefined) {
      return;
    }

    if (commands.length === 0) {
      pendingUserCommands.delete(value.command);
    }

    void endHistory(pi, history, value.exitCode);
  });
}
