import {Buffer} from 'node:buffer';
import {realpathSync, statSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {$} from 'execa';
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
// Resolve ~/.pi symlinks: Seatbelt evaluates the physical path, not the alias.
export function resolveSandboxReadPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveAllowedDirectory(cwd: string, path: string): string {
  const directory = realpathSync(resolve(cwd, path));
  if (!statSync(directory).isDirectory()) {
    throw new Error(`Not a directory: ${path}`);
  }

  return directory;
}

const skillsPaths = [
  join(homedir(), '.pi', 'agent', 'skills'),
  join(homedir(), '.pi', 'agent', 'git'),
].map(path => resolveSandboxReadPath(path));
const slopboxConfigPath = join(homedir(), '.pi', 'slopbox.json');

export function getAllowedDirectories(config: unknown, cwd: string): string[] {
  if (typeof config !== 'object' || config === null) {
    return [];
  }

  const directories = (config as Record<string, unknown>)[cwd];
  return Array.isArray(directories) && directories.every(path => typeof path === 'string')
    ? directories
    : [];
}

const srtPath = resolve(import.meta.dirname, '../../node_modules/.bin/srt');
const sandboxGuidance = [
  'Sandbox restriction: work in the current project, use mktemp for private temporary files,',
  'and treat global skills as read-only. Network access is disabled.',
  'Do not retry an outside path or seek a host-execution workaround.',
].join(' ');

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

export function formatSandboxError(message: string, fallback: string): string {
  const error = message.length > 0 ? message : fallback;
  if (!/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
    return error;
  }

  return `${error}\n\n${sandboxGuidance}`;
}

type FindArgumentsInput = {
  platform: string;
  pattern: string;
  path: string;
  ignore: readonly string[];
  limit: number;
};

export function getFindArguments({platform, pattern, path, ignore, limit}: FindArgumentsInput): string[] {
  if (platform === 'darwin') {
    const name = pattern.includes('/') ? '-path' : '-name';
    const match = name === '-path' ? `*${pattern}` : pattern;
    return [
      'find',
      path,
      '-type',
      'f',
      ...ignore.flatMap(entry => ['!', '-path', `*${entry}`]),
      name,
      match,
      '-print',
    ];
  }

  return [
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
  ];
}

export function createSandboxConfig(
  cwd: string,
  scratchPath: string,
  allowedDirectories: readonly string[] = [],
): SandboxRuntimeConfig {
  return {
    network: {allowedDomains: [], deniedDomains: []},
    filesystem: {
      // System files and global skills remain readable; user files do not.
      denyRead: [dirname(homedir())],
      allowRead: [cwd, ...allowedDirectories, ...skillsPaths],
      allowWrite: [cwd, ...allowedDirectories, scratchPath],
      denyWrite: [],
    },
  };
}

async function createSandboxSession(
  cwd: string,
  allowedDirectories: readonly string[],
): Promise<SandboxSession> {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
  const scratchPath = join(directory, 'tmp');
  const settingsPath = join(directory, 'settings.json');
  const config = createSandboxConfig(cwd, scratchPath, allowedDirectories);

  await mkdir(scratchPath);
  await writeFile(settingsPath, `${JSON.stringify(config)}\n`);
  return {directory, settingsPath, scratchPath};
}

async function removeSandboxSession(session: SandboxSession | undefined): Promise<void> {
  if (session !== undefined) {
    await rm(session.directory, {force: true, recursive: true});
  }
}

export default function slopbox(pi: ExtensionAPI): void {
  const cwd = realpathSync(process.cwd());
  const allowedDirectories = new Set<string>();
  let hasLoadedConfig = false;
  let session: SandboxSession | undefined;

  const loadConfig = async (): Promise<void> => {
    if (hasLoadedConfig) {
      return;
    }

    try {
      const config = JSON.parse(await readFile(slopboxConfigPath, 'utf8')) as unknown;
      for (const directory of getAllowedDirectories(config, cwd)) {
        allowedDirectories.add(directory);
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    hasLoadedConfig = true;
  };

  const ensureSession = async (): Promise<SandboxSession> => {
    await loadConfig();
    session ??= await createSandboxSession(cwd, [...allowedDirectories]);
    return session;
  };

  const saveConfig = async (): Promise<void> => {
    let config: Record<string, unknown> = {};
    try {
      const savedConfig = JSON.parse(await readFile(slopboxConfigPath, 'utf8')) as unknown;
      if (typeof savedConfig === 'object' && savedConfig !== null && !Array.isArray(savedConfig)) {
        config = savedConfig as Record<string, unknown>;
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    config[cwd] = [...allowedDirectories];
    await mkdir(dirname(slopboxConfigPath), {recursive: true});
    await writeFile(slopboxConfigPath, `${JSON.stringify(config, undefined, 2)}\n`);
  };

  const refreshSession = async (): Promise<void> => {
    await removeSandboxSession(session);
    session = undefined;
    await ensureSession();
  };

  const shell = async (arguments_: string[], options: RunOptions = {}) => {
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
  };

  const run = async (arguments_: string[], options?: RunOptions) => {
    const result = await shell(arguments_, options);
    if (result.exitCode !== 0) {
      throw new Error(formatSandboxError(
        result.stderr.trim(),
        `Sandbox command failed (${String(result.exitCode)})`,
      ));
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
      const stderr = result.exitCode === 0
        ? result.stderr
        : formatSandboxError(result.stderr.trim(), `Sandbox command failed (${String(result.exitCode)})`);
      onData(Buffer.from(stderr));
      return {exitCode: result.exitCode ?? null};
    },
  };
  const find: FindOperations = {
    async exists(path) {
      const result = await shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async glob(pattern, path, {ignore, limit}) {
      const output = await run(getFindArguments({
        platform: process.platform,
        pattern,
        path,
        ignore,
        limit,
      }));
      const results = output.trim().split('\n').filter(Boolean);
      return process.platform === 'darwin' ? results.slice(0, limit) : results;
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
        throw new Error(formatSandboxError(result.stderr.trim(), `rg failed (${String(result.exitCode)})`));
      }

      const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
      return {
        content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}],
        details: undefined,
      };
    },
  });

  pi.registerCommand('slopbox', {
    description: 'Allow a directory for this project. Usage: /slopbox add <directory>',
    async handler(args, ctx) {
      const [command, ...paths] = args.trim().split(/\s+/v);
      if (command !== 'add' || paths.length === 0) {
        ctx.ui.notify('Usage: /slopbox add <directory>', 'info');
        return;
      }

      try {
        const directory = resolveAllowedDirectory(cwd, paths.join(' '));
        allowedDirectories.add(directory);
        await saveConfig();
        await refreshSession();
        ctx.ui.notify(`slopbox allows ${directory}.`, 'info');
      } catch (error) {
        ctx.ui.notify(getErrorMessage(error), 'error');
      }
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
    ctx.ui.setStatus('0:slopbox', ctx.ui.theme.fg('accent', status));
  };

  pi.on('session_start', async (_event, ctx) => {
    setStatus(ctx, 'slopbox starting');
    try {
      await ensureSession();
      await run(['true']);
      setStatus(ctx, 'slopbox on');
      ctx.ui.notify(`Sandboxed tools can access only ${cwd}.`, 'info');
    } catch (error) {
      setStatus(ctx, 'slopbox off');
      ctx.ui.notify(getErrorMessage(error), 'error');
    }
  });

  pi.on('session_shutdown', async () => {
    await removeSandboxSession(session);
  });
}
