import {realpathSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
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

type CommandValue = string | number | ReadonlyArray<string | number>;

type RunOptions = {cwd: string};

type CommandResult = {
  exitCode?: number | undefined;
  stderr: string;
  stdout: string;
};

type SandboxSession = {
  scratchPath: string;
};

export class SandboxSessionManager {
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
  async startSession() {
    if (this.session !== undefined) {
      throw new Error('Sandbox session is already running.');
    }

    await this.config.load();

    const scratchPath = await mkdtemp(join(tmpdir(), 'sloppi-'));

    const agentPath = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');

    const skillPaths = ['skills', 'git', 'npm'].map(directory => {
      const path = resolve(agentPath, directory);
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    });
    const runtimeConfig = merge({
      network: {allowedDomains: [], deniedDomains: []},
      filesystem: {
        allowRead: [this.cwd, ...skillPaths],
        allowWrite: [this.cwd, scratchPath],
        denyRead: [dirname(homedir())],
        denyWrite: [],
      },
    }, this.config.getEffectiveConfig());

    await SandboxManager.initialize(SandboxRuntimeConfigSchema.parse(runtimeConfig));

    this.session = {scratchPath};
  }

  /** Runs a shell command in the active session. */
  run(strings: TemplateStringsArray, ...values: CommandValue[]): Promise<CommandResult>;
  run(options: RunOptions): (strings: TemplateStringsArray, ...values: CommandValue[]) => Promise<CommandResult>;
  run(stringsOrOptions: TemplateStringsArray | RunOptions, ...values: CommandValue[]) {
    const run = async (strings: TemplateStringsArray, commandValues: CommandValue[], cwd: string): Promise<CommandResult> => {
      const currentSession = this.session;
      if (currentSession === undefined) {
        throw new Error('Sandbox session has not started.');
      }

      let command = strings[0] ?? '';
      for (const [index, value] of commandValues.entries()) {
        const arguments_ = Array.isArray(value) ? value : [value];
        command += arguments_.map(argument => `'${String(argument).replaceAll('\'', '\'"\'"\'')}'`).join(' ');
        command += strings[index + 1] ?? '';
      }

      const wrapped = await SandboxManager.wrapWithSandbox(command);

      const execaOptions = {
        shell: true,
        reject: false,
        cwd,
        extendEnv: false,
        env: {
          HOME: currentSession.scratchPath,
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          TMPDIR: currentSession.scratchPath,
          USER: 'sandbox',
        },
      };

      return execa(wrapped, execaOptions);
    };

    return 'cwd' in stringsOrOptions
      ? async (strings: TemplateStringsArray, ...commandValues: CommandValue[]) => run(strings, commandValues, stringsOrOptions.cwd)
      : run(stringsOrOptions, values, this.cwd);
  }

  /** Recreates the session so persisted configuration changes take effect. */
  async restartSession() {
    await this.stopSession();
    return this.startSession();
  }

  /** Deletes the current session directory and clears its cached state. */
  async stopSession() {
    if (this.session === undefined) {
      return;
    }

    const {session} = this;
    await SandboxManager.reset();
    await rm(session.scratchPath, {force: true, recursive: true});

    this.session = undefined;
  }
}
