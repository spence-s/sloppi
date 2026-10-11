import {basename} from 'node:path';
import process from 'node:process';
import {
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

const atuinAuthor = 'pi';
const atuinTimeout = 10_000;

type PendingHistory = {
  cwd: string;
  id: string;
};

type UserBashOperations = {
  command: string;
  operations: BashOperations;
};

/**
Starts an Atuin history entry without making Atuin a prerequisite for command
execution. An unavailable or unconfigured Atuin installation is treated as an
optional integration failure, while a non-empty ID is retained for completion.
*/
async function startHistory(pi: ExtensionAPI, cwd: string, command: string, authorKind: 'agent' | 'user'): Promise<PendingHistory | undefined> {
  try {
    const result = await pi.exec('atuin', [
      'history',
      'start',
      ...authorKind === 'agent' ? ['--author', atuinAuthor] : [],
      '--author-kind',
      authorKind,
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
Wraps the actual user-command execution rather than a propagation-sensitive Pi
observer. Both the zsh integration and ordinary local shell path use this boundary,
so history records the original input, actual execution directory, and final code.
The explicit user kind keeps these entries visible in Atuin's default search.
*/
function recordUserBash(pi: ExtensionAPI, command: string, operations: BashOperations): BashOperations {
  return {
    /**
    Starts history immediately before execution and awaits completion before
    returning the shell result. Each execution retains its own ID, so repeated
    commands do not depend on a shared FIFO or a fire-and-forget completion event.
    */
    async exec(prefixedCommand, cwd, options) {
      const history = await startHistory(pi, cwd, command, 'user');
      let exitCode = 1;

      try {
        const result = await operations.exec(prefixedCommand, cwd, options);
        exitCode = result.exitCode ?? 1;
        return result;
      } finally {
        if (history !== undefined) {
          await endHistory(pi, history, exitCode);
        }
      }
    },
  };
}

/**
Validates the mutable operations handoff from Sloppi's zsh extension. The event
bus is synchronous, allowing the recorder to wrap execution before the handler
returns operations to Pi, regardless of which extension was loaded first.
*/
function isUserBashOperations(value: unknown): value is UserBashOperations {
  return typeof value === 'object'
    && value !== null
    && 'command' in value
    && typeof value.command === 'string'
    && 'operations' in value
    && typeof value.operations === 'object'
    && value.operations !== null
    && 'exec' in value.operations
    && typeof value.operations.exec === 'function';
}

/**
Records both model-issued Bash tool calls and user-entered `!`/`!!` commands in
Atuin. Tool calls are observed without replacing the active Bash tool. User
commands under zsh are wrapped through a synchronous operations handoff; other
shells are wrapped here. This avoids relying on the order of user_bash handlers,
because Pi stops dispatching as soon as one handler returns operations.
*/
export default function atuin(pi: ExtensionAPI): void {
  const pendingTools = new Map<string, PendingHistory>();

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') {
      return;
    }

    const {input} = event;
    if (typeof input !== 'object' || input === null || !('command' in input) || typeof input.command !== 'string' || input.command.length === 0) {
      return;
    }

    const history = await startHistory(pi, ctx.cwd, input.command, 'agent');
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

  pi.on('user_bash', event => {
    const userShell = process.env.SHELL;
    if (event.command.length === 0 || (userShell !== undefined && basename(userShell) === 'zsh')) {
      return;
    }

    const local = createLocalBashOperations(userShell === undefined ? undefined : {shellPath: userShell});
    return {operations: recordUserBash(pi, event.command, local)};
  });

  pi.events.on('sloppi:user-bash-operations', value => {
    if (!isUserBashOperations(value) || value.command.length === 0) {
      return;
    }

    value.operations = recordUserBash(pi, value.command, value.operations);
  });
}
