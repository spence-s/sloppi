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
import {NetworkConfigSchema, type SandboxRuntimeConfig} from '@anthropic-ai/sandbox-runtime';
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

type Config = Record<string, unknown>;
type ConfigScope = 'global' | 'project';

function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStrings(value: unknown): string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : [];
}

export function mergeSandboxConfig(base: Config, override: Config): Config {
  const merged = {...base};
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...new Set([...(current as unknown[]), ...(value as unknown[])])];
    } else if (isConfig(current) && isConfig(value)) {
      merged[key] = mergeSandboxConfig(current, value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function getProjectConfig(config: Config, cwd: string): Config {
  if (isConfig(config.projects) && isConfig(config.projects[cwd])) {
    return config.projects[cwd];
  }

  // Read the former {"/project": ["/directory"]} format until it is next saved.
  const directories = getStrings(config[cwd]);
  return directories.length > 0
    ? {filesystem: {allowRead: directories, allowWrite: directories}}
    : {};
}

function getEffectiveConfig(config: Config, cwd: string): Config {
  const {projects: _projects, slopbox: _slopbox, ...global} = config;
  const {slopbox: _projectSlopbox, ...project} = getProjectConfig(config, cwd);
  return mergeSandboxConfig(global, project);
}

export function getAllowedDirectories(config: unknown, cwd: string): string[] {
  if (!isConfig(config)) {
    return [];
  }

  const {filesystem} = getEffectiveConfig(config, cwd);
  return isConfig(filesystem)
    ? [...new Set([...getStrings(filesystem.allowRead), ...getStrings(filesystem.allowWrite)])]
    : [];
}

export function shouldPromptOnNetworkDeny(config: unknown, cwd: string): boolean {
  if (!isConfig(config)) {
    return true;
  }

  const global = isConfig(config.slopbox) ? config.slopbox.promptOnNetworkDeny : undefined;
  const projectConfig = getProjectConfig(config, cwd);
  const project = isConfig(projectConfig.slopbox) ? projectConfig.slopbox.promptOnNetworkDeny : undefined;
  if (typeof project === 'boolean') {
    return project;
  }

  return typeof global === 'boolean' ? global : true;
}

export function getBlockedDomain(message: string, command = ''): string | undefined {
  const violation = /deny network-outbound (?<host>.+):(?<port>\d+) \(host is not on the allow list\)/v.exec(message);
  if (violation?.groups !== undefined) {
    return `${violation.groups.host}:${violation.groups.port}`;
  }

  if (!/connection blocked by network allowlist|connect tunnel failed, response 403/iv.test(message)) {
    return undefined;
  }

  const url = /https?:\/\/[^\s"'`]+/v.exec(command)?.[0];
  if (url === undefined) {
    return undefined;
  }

  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port.length > 0 ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')}`;
}

const srtPath = resolve(import.meta.dirname, '../../node_modules/.bin/srt');
const sandboxSystemPrompt = `## Slopbox Sandbox

Filesystem tools can write only the current project, explicitly allowed directories,
and private temporary storage; global skills are read-only. Network access is
allowlisted, and host credentials, signing agents, and other host services are
unavailable unless explicitly configured. Treat a sandbox denial as a real boundary:
do not retry outside it or seek a workaround.`;
const sandboxGuidance = [
  'Sandbox restriction: work in the current project, use mktemp for private temporary files,',
  'and treat global skills as read-only. Network access is limited by the configured allowlist.',
  'Do not retry an outside path or seek a host-execution workaround.',
].join(' ');

type RunOptions = {
  debugSandbox?: boolean | undefined;
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
  config: Config = {},
): SandboxRuntimeConfig {
  const required: Config = {
    network: {allowedDomains: [], deniedDomains: []},
    filesystem: {
      // System files and global skills remain readable; user files do not.
      denyRead: [dirname(homedir())],
      allowRead: [cwd, ...allowedDirectories, ...skillsPaths],
      allowWrite: [cwd, ...allowedDirectories, scratchPath],
      denyWrite: [],
    },
  };
  return mergeSandboxConfig(getEffectiveConfig(config, cwd), required) as SandboxRuntimeConfig;
}

async function createSandboxSession(
  cwd: string,
  allowedDirectories: readonly string[],
  config: Config,
): Promise<SandboxSession> {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
  const scratchPath = join(directory, 'tmp');
  const settingsPath = join(directory, 'settings.json');
  const sandboxConfig = createSandboxConfig(cwd, scratchPath, allowedDirectories, config);

  await mkdir(scratchPath);
  await writeFile(settingsPath, `${JSON.stringify(sandboxConfig)}\n`);
  return {directory, settingsPath, scratchPath};
}

async function removeSandboxSession(session: SandboxSession | undefined): Promise<void> {
  if (session !== undefined) {
    await rm(session.directory, {force: true, recursive: true});
  }
}

export default function slopbox(pi: ExtensionAPI): void {
  const cwd = realpathSync(process.cwd());
  let config: Config = {};
  let hasLoadedConfig = false;
  let isPromptInProgress = false;
  let session: SandboxSession | undefined;

  const loadConfig = async (): Promise<void> => {
    if (hasLoadedConfig) {
      return;
    }

    try {
      const loaded = JSON.parse(await readFile(slopboxConfigPath, 'utf8')) as unknown;
      if (!isConfig(loaded)) {
        throw new Error(`${slopboxConfigPath} must contain a JSON object.`);
      }

      config = loaded;
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
    session ??= await createSandboxSession(cwd, [], config);
    return session;
  };

  const saveConfig = async (): Promise<void> => {
    const {[cwd]: _legacy, ...currentConfig} = config;
    config = currentConfig;
    await mkdir(dirname(slopboxConfigPath), {recursive: true});
    await writeFile(slopboxConfigPath, `${JSON.stringify(config, undefined, 2)}\n`);
  };

  const getScopeConfig = (scope: ConfigScope): Config => {
    if (scope === 'global') {
      return config;
    }

    const {projects: savedProjects} = config;
    const projects: Config = isConfig(savedProjects) ? savedProjects : {};
    config.projects = projects;

    const existing = projects[cwd];
    if (isConfig(existing)) {
      return existing;
    }

    const project = getProjectConfig(config, cwd);
    projects[cwd] = project;
    return project;
  };

  const addDirectory = (scope: ConfigScope, directory: string): void => {
    const scoped = getScopeConfig(scope);
    const filesystem = isConfig(scoped.filesystem) ? scoped.filesystem : {};
    filesystem.allowRead = [...new Set([...getStrings(filesystem.allowRead), directory])];
    filesystem.allowWrite = [...new Set([...getStrings(filesystem.allowWrite), directory])];
    scoped.filesystem = filesystem;
  };

  const setPrompting = (scope: ConfigScope, isEnabled: boolean): void => {
    getScopeConfig(scope).slopbox = {promptOnNetworkDeny: isEnabled};
  };

  const addDomain = (scope: ConfigScope, domain: string): void => {
    const validation = NetworkConfigSchema.safeParse({allowedDomains: [domain], deniedDomains: []});
    if (!validation.success) {
      throw new Error(`Invalid SRT domain pattern: ${domain}`);
    }

    const scoped = getScopeConfig(scope);
    const network = isConfig(scoped.network) ? scoped.network : {};
    network.allowedDomains = [...new Set([...getStrings(network.allowedDomains), domain])];
    scoped.network = network;
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
        ...(options.debugSandbox === true && {SRT_DEBUG: '1'}),
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
      const result = await shell(['sh', '-lc', command], {debugSandbox: true, signal, timeout});
      onData(Buffer.from(result.stdout));

      const blocked = /\[SandboxDebug\] No matching config rule, denying: (?<domain>\S+)/v.exec(result.stderr)?.groups?.domain;
      let isDebugBlock = false;
      const cleanStderr = result.stderr
        .split('\n')
        .filter(line => {
          if (line.startsWith('[SandboxDebug]')) {
            isDebugBlock = line.endsWith('{');
            return false;
          }

          if (isDebugBlock) {
            isDebugBlock = line !== '}';
            return false;
          }

          return true;
        })
        .join('\n')
        .trim();
      const annotatedStderr = blocked === undefined
        ? cleanStderr
        : `${cleanStderr}\n<sandbox_violations>\ndeny network-outbound ${blocked} (host is not on the allow list)\n</sandbox_violations>`;
      const stderr = result.exitCode === 0
        ? annotatedStderr
        : formatSandboxError(annotatedStderr, `Sandbox command failed (${String(result.exitCode)})`);
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
    description: 'Configure sandbox access. Usage: /slopbox [global] add|allow|status <value>',
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/v).filter(Boolean);
      const scope: ConfigScope = parts[0] === 'global' ? 'global' : 'project';
      if (scope === 'global') {
        parts.shift();
      }

      const command = parts.shift();
      try {
        await loadConfig();
        if (command === 'status' && parts.length === 0) {
          ctx.ui.notify(JSON.stringify(createSandboxConfig(cwd, '<session scratch>', [], config), undefined, 2), 'info');
          return;
        }

        if (command === 'add' && parts.length > 0) {
          const directory = resolveAllowedDirectory(cwd, parts.join(' '));
          addDirectory(scope, directory);
          await saveConfig();
          await refreshSession();
          ctx.ui.notify(`slopbox allows ${directory} (${scope}).`, 'info');
          return;
        }

        if (command === 'allow' && parts.length === 1) {
          addDomain(scope, parts[0] ?? '');
          await saveConfig();
          await refreshSession();
          ctx.ui.notify(`slopbox allows ${parts[0]} (${scope}).`, 'info');
          return;
        }

        if (command === 'prompt' && (parts[0] === 'on' || parts[0] === 'off')) {
          setPrompting(scope, parts[0] === 'on');
          await saveConfig();
          ctx.ui.notify(`slopbox network prompts are ${parts[0]} (${scope}).`, 'info');
          return;
        }

        ctx.ui.notify('Usage: /slopbox [global] add <directory> | allow <domain> | prompt on|off | status', 'info');
      } catch (error) {
        ctx.ui.notify(getErrorMessage(error), 'error');
      }
    },
  });

  pi.on('user_bash', () => ({operations: bash}));
  pi.on('project_trust', () => ({trusted: 'no'}));
  pi.on('before_agent_start', event => ({
    systemPrompt: `${event.systemPrompt}\n\n${sandboxSystemPrompt}`,
  }));
  pi.on('tool_call', event => {
    if (!sandboxedTools.has(event.toolName) && !hostTools.has(event.toolName)) {
      return {block: true, reason: `Tool ${event.toolName} is not approved for host execution.`};
    }
  });
  pi.on('tool_result', async (event, ctx) => {
    if (!sandboxedTools.has(event.toolName) || !ctx.hasUI || isPromptInProgress) {
      return;
    }

    await loadConfig();
    const message = event.content
      .filter(entry => entry.type === 'text')
      .map(entry => entry.text)
      .join('\n');
    const command = typeof event.input.command === 'string' ? event.input.command : '';
    const suggestedDomain = getBlockedDomain(message, command);
    if (suggestedDomain === undefined || !shouldPromptOnNetworkDeny(config, cwd)) {
      return;
    }

    isPromptInProgress = true;
    try {
      const projectChoice = `Allow ${suggestedDomain} for this project`;
      const globalChoice = `Allow ${suggestedDomain} for all projects`;
      const customChoice = 'Customize the SRT domain pattern…';
      const choice = await ctx.ui.select('Slopbox blocked a network request', [
        projectChoice,
        globalChoice,
        customChoice,
        'Deny',
      ]);
      if (choice === undefined || choice === 'Deny') {
        return;
      }

      const scope: ConfigScope = choice === globalChoice ? 'global' : 'project';
      const domain = choice === customChoice
        ? await ctx.ui.input('SRT domain pattern', suggestedDomain)
        : suggestedDomain;
      if (domain === undefined || domain.trim().length === 0) {
        return;
      }

      addDomain(scope, domain.trim());
      await saveConfig();
      await refreshSession();
      ctx.ui.notify(`Added ${domain.trim()} to ${scope} network.allowedDomains. Retry the command.`, 'info');
    } catch (error) {
      ctx.ui.notify(getErrorMessage(error), 'error');
    } finally {
      isPromptInProgress = false;
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
