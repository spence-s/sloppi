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
import {SandboxRuntimeConfigSchema} from '@anthropic-ai/sandbox-runtime';
import {merge} from 'object-deep-merge';
import type {ConfigStore} from './config.ts';

/**
 Resolves Pi directory symlinks because Seatbelt evaluates physical paths.
 */
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
const skillPaths = skillPathAliases.map(({path}) => path);

/**
 Rewrites absolute Pi skill paths to their physical paths for Seatbelt.
 */
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

export class Sandbox {
  session: SandboxSession | undefined;
  cwd: string;
  config: ConfigStore;

  /**
    Creates a sandbox for a project using its persisted access configuration.
   */
  constructor(cwd: string, config: ConfigStore) {
    this.cwd = cwd;
    this.config = config;
  }

  /** Creates a private sandbox session after loading its configuration. */
  async startSession(): Promise<SandboxSession> {
    if (this.session !== undefined) {
      throw new Error('Sandbox session is already running.');
    }

    await this.config.load();

    const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
    const scratchPath = join(directory, 'tmp');
    const settingsPath = join(directory, 'settings.json');
    await mkdir(scratchPath);
    const runtimeConfig = merge({
      network: {allowedDomains: [], deniedDomains: []},
      filesystem: {
        denyRead: [dirname(homedir())],
        allowRead: [this.cwd, ...skillPaths],
        allowWrite: [this.cwd, scratchPath],
        denyWrite: [],
      },
    }, this.config.getEffectiveConfig());
    const settings = JSON.stringify(SandboxRuntimeConfigSchema.parse(runtimeConfig));
    await writeFile(settingsPath, `${settings}\n`);
    this.session = {directory, settingsPath, scratchPath};
    return this.session;
  }

  /**
    Runs a command in the active session and returns its unchecked process result.
   */
  async shell(arguments_: string[], options: RunOptions = {}) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Sandbox command aborted before execution.');
    }

    const currentSession = this.session;
    if (currentSession === undefined) {
      throw new Error('Sandbox session has not started.');
    }

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
    })`${fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime/dist/cli.js'))} --settings ${currentSession.settingsPath} -- ${arguments_}`;
  }

  /**
    Runs a command and throws a guided error when it exits unsuccessfully.
   */
  async run(arguments_: string[], options?: RunOptions): Promise<string> {
    const result = await this.shell(arguments_, options);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      let error = stderr.length > 0 ? stderr : `Sandbox command failed (${String(result.exitCode)})`;
      if (/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
        error += `\n\n${[
          'Sandbox restriction: work in the current project, use mktemp for private temporary files,',
          'and treat global skills as read-only. Network access is limited by the configured allowlist.',
          'Do not retry an outside path or seek a host-execution workaround.',
        ].join(' ')}`;
      }

      throw new Error(error);
    }

    return result.stdout;
  }

  /** Recreates the session so persisted configuration changes take effect. */
  async restartSession(): Promise<SandboxSession> {
    await this.stopSession();
    return this.startSession();
  }

  /** Deletes the current session directory and clears its cached state. */
  async stopSession(): Promise<void> {
    if (this.session === undefined) {
      return;
    }

    await rm(this.session.directory, {force: true, recursive: true});
    this.session = undefined;
  }
}
