import {Buffer} from 'node:buffer';
import {realpathSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {$} from 'execa';
import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import {merge} from 'object-deep-merge';
import type {ConfigStore} from './config.ts';

// Resolve Pi directory symlinks: Seatbelt evaluates the physical path, not the alias.
export function resolveSandboxReadPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const skillPathAliases = ['skills', 'git', 'npm']
  .map(directory => resolve(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    directory,
  ))
  .map(alias => ({alias, path: resolveSandboxReadPath(alias)}));
const skillsPaths = skillPathAliases.map(({path}) => path);

// Skill locations may be advertised through a symlinked Pi directory. Seatbelt
// checks the path supplied to a tool, while its policy uses the physical path.
export function resolveSandboxToolPath(path: string): string {
  if (!isAbsolute(path)) {
    return path;
  }

  const absolutePath = resolve(path);
  for (const {alias, path: physicalPath} of skillPathAliases) {
    const suffix = relative(alias, absolutePath);
    if (suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))) {
      return join(physicalPath, suffix);
    }
  }

  return path;
}

const srtPath = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime/dist/cli.js'));
const sandboxGuidance = [
  'Sandbox restriction: work in the current project, use mktemp for private temporary files,',
  'and treat global skills as read-only. Network access is limited by the configured allowlist.',
  'Do not retry an outside path or seek a host-execution workaround.',
].join(' ');

export type RunOptions = {
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

export function formatSandboxError(message: string, fallback: string): string {
  const error = message.length > 0 ? message : fallback;
  if (!/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
    return error;
  }

  return `${error}\n\n${sandboxGuidance}`;
}

export class Sandbox {
  session: SandboxSession | undefined;
  cwd: string;
  config: ConfigStore;

  constructor(cwd: string, config: ConfigStore) {
    this.cwd = cwd;
    this.config = config;
  }

  createConfig(scratchPath: string, allowedDirectories: readonly string[] = []): SandboxRuntimeConfig {
    const required = {
      network: {allowedDomains: [], deniedDomains: []},
      filesystem: {
        denyRead: [dirname(homedir())],
        allowRead: [this.cwd, ...allowedDirectories, ...skillsPaths],
        allowWrite: [this.cwd, ...allowedDirectories, scratchPath],
        denyWrite: [],
      },
    };
    return SandboxRuntimeConfigSchema.parse(merge(this.config.getEffectiveConfig(), required));
  }

  async ensureSession(): Promise<SandboxSession> {
    await this.config.load();
    if (this.session !== undefined) {
      return this.session;
    }

    const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
    const scratchPath = join(directory, 'tmp');
    const settingsPath = join(directory, 'settings.json');
    await mkdir(scratchPath);
    await writeFile(settingsPath, `${JSON.stringify(this.createConfig(scratchPath))}\n`);
    this.session = {directory, settingsPath, scratchPath};
    return this.session;
  }

  async shell(arguments_: string[], options: RunOptions = {}) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Sandbox command aborted before execution.');
    }

    const currentSession = await this.ensureSession();
    return $({
      reject: false,
      cwd: this.cwd,
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
  }

  async run(arguments_: string[], options?: RunOptions): Promise<string> {
    const result = await this.shell(arguments_, options);
    if (result.exitCode !== 0) {
      throw new Error(formatSandboxError(
        result.stderr.trim(),
        `Sandbox command failed (${String(result.exitCode)})`,
      ));
    }

    return result.stdout;
  }

  async refresh(): Promise<void> {
    await this.shutdown();
    await this.ensureSession();
  }

  async shutdown(): Promise<void> {
    if (this.session === undefined) {
      return;
    }

    await rm(this.session.directory, {force: true, recursive: true});
    this.session = undefined;
  }
}
