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

type RunOptions = {
  // Run inside this directory after the sandbox policy has wrapped the command.
  cwd: string;
  // Send large or binary input through stdin instead of embedding it in a shell command.
  input?: string | Uint8Array | undefined;
  // Merge stdout and stderr for interactive consumers such as Pi's bash tool.
  onData?: ((data: Uint8Array) => void) | undefined;
  // Keep structured stdout separate when it must be parsed, as with `rg --json`.
  onStdout?: ((data: Uint8Array) => void) | undefined;
  // Deliver diagnostics separately from structured stdout.
  onStderr?: ((data: Uint8Array) => void) | undefined;
  // Cancel the wrapped process and every descendant started through its shell.
  signal?: AbortSignal | undefined;
  // Sandbox tool APIs express timeout in seconds; Execa receives milliseconds below.
  timeout?: number | undefined;
};

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
 Restores process-level temporary directory overrides after a sandbox stops or fails.
 */
const restoreEnvironment = (session: SandboxSession): void => {
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
    const runtimeConfigValidation = SandboxRuntimeConfigSchema.safeParse(runtimeConfig);
    if (!runtimeConfigValidation.success) {
      await rm(scratchPath, {force: true, recursive: true});
      throw runtimeConfigValidation.error;
    }

    const parsedRuntimeConfig = runtimeConfigValidation.data;
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
      restoreEnvironment({previousClaudeCodeTmpdir, previousTmpdir, scratchPath});
      await rm(scratchPath, {force: true, recursive: true});
      throw error;
    }
  }

  /** Runs a shell command in the active session. */
  run(strings: TemplateStringsArray, ...values: CommandValue[]): Promise<CommandResult>;
  run(options: RunOptions): (strings: TemplateStringsArray, ...values: CommandValue[]) => Promise<CommandResult>;
  run(stringsOrOptions: TemplateStringsArray | RunOptions, ...values: CommandValue[]) {
    const run = async (strings: TemplateStringsArray, commandValues: CommandValue[], options: RunOptions): Promise<CommandResult> => {
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
        if (value !== undefined && (name === 'HOME' || env[name] === undefined)) {
          env[name] = value;
        }
      }

      /*
       Execa normally buffers stdout and stderr until the process exits. That is convenient for
       short commands, but grep must inspect output while ripgrep is still running so it can stop
       at the global match limit. Supplying any stream callback transfers buffering responsibility
       to that caller and prevents Execa from retaining a second, potentially large copy.
       */
      const shouldStream = options.onData !== undefined
        || options.onStdout !== undefined
        || options.onStderr !== undefined;
      const subprocess = execa(wrapped, {
        ...(options.input !== undefined && {input: options.input}),
        ...(options.signal !== undefined && {cancelSignal: options.signal}),
        ...(options.timeout !== undefined && {timeout: options.timeout * 1000}),
        buffer: !shouldStream,
        // The sandbox wrapper uses a shell; cancellation must also stop commands launched by it.
        killDescendants: true,
        shell: true,
        // Return ordinary non-zero exits for tool-specific handling; cancellation still rejects below.
        reject: false,
        cwd: options.cwd,
        extendEnv: false,
        env,
      });
      /*
       `onData` intentionally merges both streams for interactive commands such as bash, where Pi
       should display output as it arrives regardless of its source.
       */
      if (options.onData !== undefined) {
        subprocess.stdout?.on('data', options.onData);
        subprocess.stderr?.on('data', options.onData);
      }

      /*
       Structured tools need separate callbacks: grep parses stdout as JSON but must retain stderr
       as plain diagnostic text. Optional chaining also tolerates commands without a piped stream.
       */
      if (options.onStdout !== undefined) {
        subprocess.stdout?.on('data', options.onStdout);
      }

      if (options.onStderr !== undefined) {
        subprocess.stderr?.on('data', options.onStderr);
      }

      // Waiting here resolves buffered commands and keeps streaming commands alive until termination.
      const result = await subprocess;

      // Normalize Execa's cancellation state into the error contract used by sandboxed tools.
      if (result.isCanceled) {
        throw new Error('aborted');
      }

      // Keep timeout distinct from cancellation so the bash tool can report the configured duration.
      if (result.timedOut) {
        throw new Error(`timeout:${String(options.timeout)}`);
      }

      /*
       Streaming commands have no buffered `stdout` or `stderr`, so Execa leaves them undefined.
       Normalize both to strings to keep every `sandbox.run` caller on one simple result shape.
       */
      return {
        ...result,
        stderr: result.stderr ?? '',
        stdout: result.stdout ?? '',
      };
    };

    return 'cwd' in stringsOrOptions
      ? async (strings: TemplateStringsArray, ...commandValues: CommandValue[]) => run(strings, commandValues, stringsOrOptions)
      : run(stringsOrOptions, values, {cwd: this.cwd});
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
      restoreEnvironment(session);
      this.session = undefined;
      await rm(session.scratchPath, {force: true, recursive: true});
    }
  }
}
