import {Buffer} from 'node:buffer';
import {realpathSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {$} from 'execa';
import PQueue from 'p-queue';
import type {SandboxRuntimeConfig} from '@anthropic-ai/sandbox-runtime';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';

// Only these tools may execute commands; everything else stays explicitly allowlisted.
const sandboxedTools = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
// These provider-backed tools intentionally stay on the credential-holding host.
const hostTools = new Set(['fetch_content', 'get_search_content', 'source_check', 'web_search']);
const sandboxConcurrency = 4;
const srtPath = resolve(import.meta.dirname, '../../node_modules/.bin/srt');

type RunOptions = {
  input?: string | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
};

type SandboxSession = {
  directory: string;
  settingsPath: string;
  scratchPath: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSandboxConfig(cwd: string, scratchPath: string): SandboxRuntimeConfig {
  return {
    network: {allowedDomains: [], deniedDomains: ['*']},
    filesystem: {
      // System files remain readable so developer tools can run; user files do not.
      denyRead: [dirname(homedir())],
      allowRead: [cwd],
      allowWrite: [cwd, scratchPath],
      denyWrite: [],
    },
  };
}

async function createSandboxSession(cwd: string): Promise<SandboxSession> {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
  const scratchPath = join(directory, 'tmp');
  const settingsPath = join(directory, 'settings.json');
  const config = createSandboxConfig(cwd, scratchPath);

  await mkdir(scratchPath);
  await writeFile(settingsPath, `${JSON.stringify(config)}\n`);
  return {directory, settingsPath, scratchPath};
}

async function removeSandboxSession(session: SandboxSession | undefined): Promise<void> {
  if (session !== undefined) {
    await rm(session.directory, {force: true, recursive: true});
  }
}

export default function sandboxTools(pi: ExtensionAPI): void {
  const cwd = realpathSync(process.cwd());
  const queue = new PQueue({concurrency: sandboxConcurrency});
  let session: SandboxSession | undefined;

  const ensureSession = async (): Promise<SandboxSession> => {
    session ??= await createSandboxSession(cwd);
    return session;
  };

  const shell = async (arguments_: string[], options: RunOptions = {}) => queue.add(async () => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Sandbox command aborted before execution.');
    }

    const currentSession = await ensureSession();
    return $({
      reject: false,
      cwd,
      // Do not pass host credentials or proxy settings into an agent-controlled process.
      env: {
        HOME: currentSession.scratchPath,
        LANG: process.env.LANG ?? 'C.UTF-8',
        PATH: process.env.PATH ?? '',
        TMPDIR: currentSession.scratchPath,
        USER: 'sandbox',
      },
      ...(options.input !== undefined && {input: options.input}),
      ...(options.signal !== undefined && {cancelSignal: options.signal}),
      ...(options.timeout !== undefined && {timeout: options.timeout * 1000}),
    })`${srtPath} --settings ${currentSession.settingsPath} -- ${arguments_}`;
  });

  const run = async (arguments_: string[], options?: RunOptions) => {
    const result = await shell(arguments_, options);
    if (result.exitCode !== 0) {
      const message = result.stderr.trim();
      throw new Error(message.length > 0 ? message : `Sandbox command failed (${String(result.exitCode)})`);
    }

    return result.stdout;
  };

  const read: ReadOperations = {
    async access(path) {
      await run(['test', '-r', path]);
    },
    async readFile(path) {
      const output = await run(['sh', '-c', 'base64 < "$1" | tr -d "\n"', 'sh', path]);
      return Buffer.from(output, 'base64');
    },
    async detectImageMimeType(path) {
      const output = await run(['file', '--mime-type', '-b', '--', path]);
      const mime = output.trim();
      return ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null;
    },
  };
  const write: WriteOperations = {
    async mkdir(path) {
      await run(['mkdir', '-p', '--', path]);
    },
    async writeFile(path, content) {
      await run(['sh', '-c', 'cat > "$1"', 'sh', path], {input: content});
    },
  };
  const edit: EditOperations = {
    ...read,
    ...write,
    async access(path) {
      await run(['sh', '-c', 'test -r "$1" && test -w "$1"', 'sh', path]);
    },
  };
  const bash: BashOperations = {
    async exec(command, _commandCwd, {onData, signal, timeout}) {
      const result = await shell(['sh', '-lc', command], {signal, timeout});
      onData(Buffer.from(result.stdout));
      onData(Buffer.from(result.stderr));
      return {exitCode: result.exitCode ?? null};
    },
  };
  const find: FindOperations = {
    async exists(path) {
      const result = await shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async glob(pattern, path, {ignore, limit}) {
      const output = await run([
        'fd',
        '--glob',
        '--color=never',
        '--hidden',
        ...ignore.flatMap(entry => ['--exclude', entry]),
        '--max-results',
        String(limit),
        '--',
        pattern,
        path,
      ]);
      return output.trim().split('\n').filter(Boolean);
    },
  };
  const ls: LsOperations = {
    async exists(path) {
      const result = await shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async stat(path) {
      const exists = await shell(['test', '-e', path]);
      if (exists.exitCode !== 0) {
        throw new Error(`Path not found: ${path}`);
      }

      const directory = await shell(['test', '-d', path]);
      return {isDirectory: () => directory.exitCode === 0};
    },
    async readdir(path) {
      const output = await run(['ls', '-1A', '--', path]);
      return output.trim().split('\n').filter(Boolean);
    },
  };

  pi.registerTool(createReadTool(cwd, {operations: read}));
  pi.registerTool(createWriteTool(cwd, {operations: write}));
  pi.registerTool(createEditTool(cwd, {operations: edit}));
  pi.registerTool(createBashTool(cwd, {operations: bash, exposeSessionEnvironment: false}));
  pi.registerTool(createFindTool(cwd, {operations: find}));
  pi.registerTool(createLsTool(cwd, {operations: ls}));

  pi.registerTool({
    ...createGrepTool(cwd),
    async execute(_id, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}, signal) {
      const arguments_ = ['rg', '--line-number', '--color=never', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**'];
      if (ignoreCase === true) {
        arguments_.push('--ignore-case');
      }

      if (literal === true) {
        arguments_.push('--fixed-strings');
      }

      if (glob !== undefined) {
        arguments_.push('--glob', glob);
      }

      if (context !== undefined && context > 0) {
        arguments_.push('--context', String(context));
      }

      arguments_.push('--', pattern, path);

      const result = await shell(arguments_, {signal});
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        const message = result.stderr.trim();
        throw new Error(message.length > 0 ? message : `rg failed (${String(result.exitCode)})`);
      }

      const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
      return {
        content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}],
        details: undefined,
      };
    },
  });

  pi.on('user_bash', () => ({operations: bash}));
  pi.on('project_trust', () => ({trusted: 'no'}));
  pi.on('tool_call', event => {
    if (!sandboxedTools.has(event.toolName) && !hostTools.has(event.toolName)) {
      return {block: true, reason: `Tool ${event.toolName} is not approved for host execution.`};
    }
  });

  const setStatus = (ctx: ExtensionContext, status: string): void => {
    ctx.ui.setStatus('0:sandbox', ctx.ui.theme.fg('accent', status));
  };

  pi.on('session_start', async (_event, ctx) => {
    setStatus(ctx, 'Sandbox: starting…');
    try {
      await ensureSession();
      await run(['true']);
      setStatus(ctx, 'Sandbox: project only');
      ctx.ui.notify(`Sandboxed tools can access only ${cwd}.`, 'info');
    } catch (error) {
      setStatus(ctx, 'Sandbox: unavailable');
      ctx.ui.notify(getErrorMessage(error), 'error');
    }
  });

  pi.on('session_shutdown', async () => {
    await removeSandboxSession(session);
  });
}
