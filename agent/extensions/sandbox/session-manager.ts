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
  previousClaudeCodeTmpdir: string | undefined;
  previousTmpdir: string | undefined;
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

    const globalSkillPaths = [
      // inside ~/.pi/agent
      ...['skills', 'git', 'npm'].map(directory => resolve(agentPath, directory)),
      // inside ~/.agents/skills
      join(homedir(), '.agents', 'skills'),
    ];

    const runtimeConfig = merge({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [scratchPath],
      },
      filesystem: {
        allowRead: [this.cwd, ...globalSkillPaths],
        allowWrite: [this.cwd, scratchPath],
        denyRead: [dirname(homedir())],
        denyWrite: [],
      },
    }, this.config.getEffectiveConfig());
    const parsedRuntimeConfig = SandboxRuntimeConfigSchema.parse(runtimeConfig);

    /*
     * With filesystem isolation enabled, SRT ignores TMPDIR when wrapping a
     * command. It reads CLAUDE_CODE_TMPDIR from this parent process and otherwise
     * falls back to the shared /tmp/claude path. SRT's own proxy separately uses
     * os.tmpdir(), so TMPDIR must match too. Keep both overrides for the session
     * so normal tools and nested SRT tests use our private writable directory,
     * where Unix sockets are narrowly allowed instead of exposing host sockets.
     */
    const previousClaudeCodeTmpdir = process.env.CLAUDE_CODE_TMPDIR;
    const previousTmpdir = process.env.TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = scratchPath;
    process.env.TMPDIR = scratchPath;
    try {
      await SandboxManager.initialize(parsedRuntimeConfig);
      this.session = {previousClaudeCodeTmpdir, previousTmpdir, scratchPath};
    } catch (error) {
      if (previousClaudeCodeTmpdir === undefined) {
        delete process.env.CLAUDE_CODE_TMPDIR;
      } else {
        process.env.CLAUDE_CODE_TMPDIR = previousClaudeCodeTmpdir;
      }

      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }

      await rm(scratchPath, {force: true, recursive: true});
      throw error;
    }
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

      const env: Record<string, string> = {
        CLAUDE_CODE_TMPDIR: currentSession.scratchPath,
        HOME: currentSession.scratchPath,
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        TMPDIR: currentSession.scratchPath,
        USER: 'sandbox',
      };
      for (const name of this.config.getExposedEnv()) {
        const value = process.env[name];
        if (value !== undefined && env[name] === undefined) {
          env[name] = value;
        }
      }

      const execaOptions = {
        shell: true,
        reject: false,
        cwd,
        extendEnv: false,
        env,
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
    try {
      await SandboxManager.reset();
    } finally {
      if (session.previousClaudeCodeTmpdir === undefined) {
        delete process.env.CLAUDE_CODE_TMPDIR;
      } else {
        process.env.CLAUDE_CODE_TMPDIR = session.previousClaudeCodeTmpdir;
      }

      if (session.previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = session.previousTmpdir;
      }

      this.session = undefined;
      await rm(session.scratchPath, {force: true, recursive: true});
    }
  }
}
