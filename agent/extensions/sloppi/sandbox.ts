import {realpathSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {execa} from 'execa';
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
} from '@anthropic-ai/sandbox-runtime';
import {merge} from 'object-deep-merge';
import type {ConfigStore} from './config.ts';

const agentPath = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');

const skillPaths = ['skills', 'git', 'npm'].map(directory => {
  const path = resolve(agentPath, directory);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
});

export type RunOptions = {
  input?: string | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
};

type CommandValue = string | number | ReadonlyArray<string | number>;
type CommandResult = {
  exitCode?: number | undefined;
  stderr: string;
  stdout: string;
};

type SandboxSession = {
  directory: string;
  scratchPath: string;
  claudeTemporaryPath: string | undefined;
  temporaryPath: string | undefined;
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

  async #execute(strings: TemplateStringsArray, values: CommandValue[], options: RunOptions): Promise<CommandResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error('Sandbox command aborted before execution.');
    }

    const currentSession = this.session;
    if (currentSession === undefined) {
      throw new Error('Sandbox session has not started.');
    }

    let command = strings[0] ?? '';
    for (const [index, value] of values.entries()) {
      const arguments_ = Array.isArray(value) ? value : [value];
      command += arguments_.map(argument => `'${String(argument).replaceAll('\'', '\'"\'"\'')}'`).join(' ');
      command += strings[index + 1] ?? '';
    }

    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh', undefined, options.signal, this.cwd);
    const executable = wrapped.argv[0];
    if (executable === undefined) {
      throw new Error('Sandbox did not provide a command to run.');
    }

    const result = await execa(executable, wrapped.argv.slice(1), {
      reject: false,
      cwd: this.cwd,
      // Do not pass host credentials or proxy settings into an agent-controlled process.
      env: {
        ...wrapped.env,
        HOME: currentSession.scratchPath,
        LANG: process.env.LANG ?? 'C.UTF-8',
        PATH: process.env.PATH ?? '',
        TMPDIR: currentSession.scratchPath,
        USER: 'sandbox',
      },
      ...(options.input !== undefined && {input: options.input}),
      ...(options.signal !== undefined && {cancelSignal: options.signal}),
      ...(options.timeout !== undefined && {timeout: options.timeout * 1000}),
    });
    return {...result, stderr: SandboxManager.annotateStderrWithSandboxFailures(command, result.stderr)};
  }

  /** Creates a private sandbox session after loading its configuration. */
  async startSession(): Promise<SandboxSession> {
    if (this.session !== undefined) {
      throw new Error('Sandbox session is already running.');
    }

    await this.config.load();

    const directory = await mkdtemp(join(tmpdir(), 'sloppi-'));
    const scratchPath = join(directory, 'tmp');
    await mkdir(scratchPath);
    const claudeTemporaryPath = process.env.CLAUDE_CODE_TMPDIR;
    const temporaryPath = process.env.TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = scratchPath;
    process.env.TMPDIR = '/tmp/claude';
    const runtimeConfig = merge({
      network: {allowedDomains: [], deniedDomains: []},
      filesystem: {
        denyRead: [dirname(homedir())],
        allowRead: [this.cwd, ...skillPaths],
        allowWrite: [this.cwd, scratchPath],
        denyWrite: [],
      },
    }, this.config.getEffectiveConfig());
    try {
      await SandboxManager.initialize(SandboxRuntimeConfigSchema.parse(runtimeConfig));
    } catch (error) {
      if (claudeTemporaryPath === undefined) {
        delete process.env.CLAUDE_CODE_TMPDIR;
      } else {
        process.env.CLAUDE_CODE_TMPDIR = claudeTemporaryPath;
      }

      if (temporaryPath === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = temporaryPath;
      }

      await rm(directory, {force: true, recursive: true});
      throw error;
    }

    this.session = {
      directory,
      scratchPath,
      claudeTemporaryPath,
      temporaryPath,
    };
    return this.session;
  }

  /** Runs a shell command in the active session. Interpolated values are shell-quoted. */
  run(strings: TemplateStringsArray, ...values: CommandValue[]): Promise<CommandResult>;
  run(options: RunOptions): (strings: TemplateStringsArray, ...values: CommandValue[]) => Promise<CommandResult>;
  run(stringsOrOptions: TemplateStringsArray | RunOptions, ...values: CommandValue[]) {
    if ('raw' in stringsOrOptions) {
      return this.#execute(stringsOrOptions, values, {});
    }

    return async (strings: TemplateStringsArray, ...commandValues: CommandValue[]) => this.#execute(strings, commandValues, stringsOrOptions);
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

    const {session} = this;
    await SandboxManager.reset();
    if (session.claudeTemporaryPath === undefined) {
      delete process.env.CLAUDE_CODE_TMPDIR;
    } else {
      process.env.CLAUDE_CODE_TMPDIR = session.claudeTemporaryPath;
    }

    if (session.temporaryPath === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = session.temporaryPath;
    }

    await rm(session.directory, {force: true, recursive: true});
    this.session = undefined;
  }
}
