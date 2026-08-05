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
import type {SandboxRuntimeConfig} from '@anthropic-ai/sandbox-runtime';
import {getEffectiveConfig, mergeSandboxConfig, type Config} from './config.ts';

// Resolve ~/.pi symlinks: Seatbelt evaluates the physical path, not the alias.
export function resolveSandboxReadPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const skillsPaths = [
  join(homedir(), '.pi', 'agent', 'skills'),
  join(homedir(), '.pi', 'agent', 'git'),
].map(path => resolveSandboxReadPath(path));

const srtPath = resolve(import.meta.dirname, '../../../node_modules/.bin/srt');
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

export function createSandbox(cwd: string, loadConfig: () => Promise<Config>) {
  let session: SandboxSession | undefined;

  const ensureSession = async (): Promise<SandboxSession> => {
    const config = await loadConfig();
    session ??= await createSandboxSession(cwd, [], config);
    return session;
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

  const run = async (arguments_: string[], options?: RunOptions): Promise<string> => {
    const result = await shell(arguments_, options);
    if (result.exitCode !== 0) {
      throw new Error(formatSandboxError(
        result.stderr.trim(),
        `Sandbox command failed (${String(result.exitCode)})`,
      ));
    }

    return result.stdout;
  };

  return {
    ensureSession,
    shell,
    run,
    async refresh(): Promise<void> {
      await removeSandboxSession(session);
      session = undefined;
      await ensureSession();
    },
    async shutdown(): Promise<void> {
      await removeSandboxSession(session);
    },
  };
}

export type Sandbox = ReturnType<typeof createSandbox>;
