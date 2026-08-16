import {mkdtemp, rm, realpath} from 'node:fs/promises';
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

/**
 Evaluates a path to its real path, or returns the original path if it does not exist.
 */
const safeRealPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

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

/**
 Checks whether an exact policy destination is covered by an SRT domain pattern.
 */
const isDomainPatternMatch = (destination: string, pattern: string): boolean => {
  /**
   Separates the optional port without breaking bracketed IPv6 hosts.
   */
  const split = (value: string): {host: string; port: string | undefined} => {
    if (value.startsWith('[')) {
      const bracket = value.indexOf(']');
      return {
        host: value.slice(0, bracket + 1).toLowerCase(),
        port: value[bracket + 1] === ':' ? value.slice(bracket + 2) : undefined,
      };
    }

    const separator = value.lastIndexOf(':');
    const hasPort = separator > 0 && /^\d+$/v.test(value.slice(separator + 1));
    return {
      host: (hasPort ? value.slice(0, separator) : value).toLowerCase(),
      port: hasPort ? value.slice(separator + 1) : undefined,
    };
  };

  const exact = split(destination);
  const candidate = split(pattern);
  return (candidate.port === undefined || candidate.port === exact.port)
    && (
      candidate.host === '*'
      || candidate.host === exact.host
      || (candidate.host.startsWith('*.') && exact.host.endsWith(candidate.host.slice(1)))
    );
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
    const requestPolicies = this.config.getRequestPolicies();

    const scratchPath = await mkdtemp(join(tmpdir(), 'sloppi-'));

    /**
     We need to allow all agents from anywhere the ability to read global skills.
     We need also account for the potential of the skills being symlinked,
     so we allow the real paths of those as well.
     */
    const homeDirectory = homedir();
    const piAgentPath = process.env.PI_CODING_AGENT_DIR ?? join(homeDirectory, '.pi', 'agent');
    const agentsSkillPath = join(homeDirectory, '.agents', 'skills');
    const globalPiSkillPaths = ['skills', 'git', 'npm'].map(directory => resolve(piAgentPath, directory));
    const realGlobalPiSkillPaths = await Promise.all(globalPiSkillPaths.map(async path => safeRealPath(path)));

    const globalSkillPaths = [
      ...new Set([
        ...globalPiSkillPaths,
        ...realGlobalPiSkillPaths,
        agentsSkillPath,
        await safeRealPath(agentsSkillPath),
      ]),
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
        denyRead: [homeDirectory],
        denyWrite: [],
      },
    }, this.config.getEffectiveConfig());
    const parsedRuntimeConfig = SandboxRuntimeConfigSchema.parse(runtimeConfig);
    if (requestPolicies.length > 0) {
      const excludedDomains = parsedRuntimeConfig.network.tlsTerminate?.excludeDomains ?? [];
      const excludedDestination = requestPolicies.find(policy =>
        excludedDomains.some(pattern => isDomainPatternMatch(policy.destination, pattern)));
      if (excludedDestination !== undefined) {
        await rm(scratchPath, {force: true, recursive: true});
        throw new Error(`Request policy destination ${excludedDestination.destination} cannot be excluded from TLS termination.`);
      }

      const rulesByDestination = new Map<string, typeof requestPolicies[number]['allow']>();
      for (const policy of requestPolicies) {
        rulesByDestination.set(policy.destination, [
          ...(rulesByDestination.get(policy.destination) ?? []),
          ...policy.allow,
        ]);
      }

      parsedRuntimeConfig.network.tlsTerminate ??= {};
      /**
       Allows unprotected destinations and fails closed when protected requests do not match.
       */
      parsedRuntimeConfig.network.filterRequest = async request => {
        const url = new URL(request.url);
        const port = url.port.length > 0 ? url.port : (url.protocol === 'https:' ? '443' : '80');
        const destination = `${url.hostname.toLowerCase().replace(/\.$/v, '')}:${port}`;
        const rules = rulesByDestination.get(destination);
        if (rules === undefined) {
          return {action: 'allow'};
        }

        const isAllowed = rules.some(rule => {
          if (rule.methods !== undefined && !rule.methods.includes(request.method.toUpperCase())) {
            return false;
          }

          const hasPathRule = rule.paths !== undefined || rule.pathPrefixes !== undefined;
          const isPathMatch = rule.paths?.includes(url.pathname) === true
            || rule.pathPrefixes?.some(prefix => url.pathname === prefix
              || url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) === true;
          if (hasPathRule && !isPathMatch) {
            return false;
          }

          return Object.entries(rule.headers ?? {}).every(([name, values]) => {
            const value = request.headers.get(name);
            return value !== null && values.includes(value);
          });
        });

        return isAllowed
          ? {action: 'allow'}
          : {action: 'deny', reason: `Request does not match the configured policy for ${destination}.`};
      };
    }

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
        NODE_USE_ENV_PROXY: '1',
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
