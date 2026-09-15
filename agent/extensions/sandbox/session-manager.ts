import {Buffer} from 'node:buffer';
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {
  dirname,
  join,
  parse,
  resolve,
} from 'node:path';
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
  // Pipe stdout into a second sandboxed command without buffering the source.
  pipe?: ReadonlyArray<string | number> | undefined;
  // Filter complete stdout lines before passing them to a piped command.
  transformStdout?: ((line: string) => string | undefined) | undefined;
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
  isEnabled = true;
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
    const systemRoot = parse(this.cwd).root;
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
    // The workspace must remain usable while the rest of the home folder stays private.
    const {filesystem} = parsedRuntimeConfig;
    filesystem.allowRead = [...new Set([
      ...(filesystem.allowRead ?? []).filter(path => path !== homeDirectory || path === this.cwd),
      this.cwd,
    ])];
    filesystem.allowWrite = [...new Set([
      ...(filesystem.allowWrite ?? []).filter(path => path !== homeDirectory && path !== systemRoot),
      this.cwd,
    ])];
    filesystem.denyRead = [...new Set([
      ...(filesystem.denyRead ?? []).filter(path => path !== systemRoot && path !== this.cwd),
      ...([systemRoot, this.cwd].includes(homeDirectory) ? [] : [homeDirectory]),
    ])];
    filesystem.denyWrite = (filesystem.denyWrite ?? []).filter(path => path !== systemRoot && path !== this.cwd);
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
      let command = strings[0] ?? '';
      for (const [index, value] of commandValues.entries()) {
        const arguments_ = Array.isArray(value) ? value : [value];
        command += arguments_.map(argument => `'${String(argument).replaceAll('\'', '\'"\'"\'')}'`).join(' ');
        command += strings[index + 1] ?? '';
      }

      const currentSession = this.session;
      if (this.isEnabled && currentSession === undefined) {
        throw new Error('Sandbox session has not started.');
      }

      let wrappedCommandCount = 0;
      let executable = command;
      let pipedExecutable: string | undefined;
      try {
        if (this.isEnabled) {
          executable = await SandboxManager.wrapWithSandbox(command);
          wrappedCommandCount++;
        }

        const pipeCommand = options.pipe?.map(argument => `'${String(argument).replaceAll('\'', '\'"\'"\'')}'`).join(' ');
        if (pipeCommand !== undefined) {
          pipedExecutable = this.isEnabled ? await SandboxManager.wrapWithSandbox(pipeCommand) : pipeCommand;
          if (this.isEnabled) {
            wrappedCommandCount++;
          }
        }
      } catch (error) {
        for (let index = 0; index < wrappedCommandCount; index++) {
          SandboxManager.cleanupAfterCommand();
        }

        throw error;
      }

      let sandboxEnvironment: {env: Record<string, string>; extendEnv: false} | undefined;
      if (this.isEnabled && currentSession !== undefined) {
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

        sandboxEnvironment = {env, extendEnv: false};
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
      const commandOptions = {
        ...(options.signal !== undefined && {cancelSignal: options.signal}),
        ...(options.timeout !== undefined && {timeout: options.timeout * 1000}),
        // The sandbox wrapper uses a shell; cancellation must also stop commands launched by it.
        killDescendants: true,
        shell: true,
        // Return ordinary non-zero exits for tool-specific handling; cancellation still rejects below.
        reject: false,
        cwd: options.cwd,
        ...sandboxEnvironment,
      } as const;
      const transformStdout = options.transformStdout === undefined
        ? undefined
        : function * (line: string) {
          const transformed = options.transformStdout?.(line);
          if (transformed !== undefined) {
            yield transformed;
          }
        };

      try {
        const source = execa(executable, {
          ...commandOptions,
          ...(options.input !== undefined && {input: options.input}),
          ...(transformStdout !== undefined && {stdout: transformStdout}),
          buffer: !shouldStream && pipedExecutable === undefined,
        });
        const subprocess = pipedExecutable === undefined
          ? source
          : source.pipe(pipedExecutable, {...commandOptions, buffer: !shouldStream});
        let pipedStderr = '';
        if (pipedExecutable !== undefined) {
          source.stderr?.on('data', data => {
            pipedStderr += Buffer.from(data).toString();
          });
        }

        /*
         `onData` intentionally merges both streams for interactive commands such as bash, where Pi
         should display output as it arrives regardless of its source.
         */
        if (options.onData !== undefined) {
          source.stdout?.on('data', options.onData);
          source.stderr?.on('data', options.onData);
        }

        /*
         Structured tools need separate callbacks: grep parses stdout as JSON but must retain stderr
         as plain diagnostic text. Optional chaining also tolerates commands without a piped stream.
         */
        if (options.onStdout !== undefined) {
          source.stdout?.on('data', options.onStdout);
        }

        if (options.onStderr !== undefined) {
          source.stderr?.on('data', options.onStderr);
        }

        // Waiting here resolves buffered commands and keeps streaming commands alive until termination.
        const result = await subprocess;

        const pipelineResults = [result, ...result.pipedFrom];
        // Normalize Execa's cancellation state into the error contract used by sandboxed tools.
        if (pipelineResults.some(entry => entry.isCanceled)) {
          throw new Error('aborted');
        }

        // Keep timeout distinct from cancellation so the bash tool can report the configured duration.
        if (pipelineResults.some(entry => entry.timedOut)) {
          throw new Error(`timeout:${String(options.timeout)}`);
        }

        /*
         Streaming commands have no buffered `stdout` or `stderr`, so Execa leaves them undefined.
         Normalize both to strings to keep every `sandbox.run` caller on one simple result shape.
         */
        return {
          ...result,
          exitCode: pipelineResults.find(entry => entry.exitCode !== 0)?.exitCode ?? result.exitCode,
          stderr: `${pipedStderr}${result.stderr ?? ''}`,
          stdout: result.stdout ?? '',
        };
      } finally {
        for (let index = 0; index < wrappedCommandCount; index++) {
          SandboxManager.cleanupAfterCommand();
        }
      }
    };

    return 'cwd' in stringsOrOptions
      ? async (strings: TemplateStringsArray, ...commandValues: CommandValue[]) => run(strings, commandValues, stringsOrOptions)
      : run(stringsOrOptions, values, {cwd: this.cwd});
  }

  /** Enables or disables SRT routing for the current Pi session. */
  async setEnabled(isEnabled: boolean): Promise<void> {
    if (isEnabled === this.isEnabled) {
      return;
    }

    if (!isEnabled) {
      await this.stopSession();
      this.isEnabled = false;
      return;
    }

    this.isEnabled = true;
    try {
      await this.startSession();
    } catch (error) {
      this.isEnabled = false;
      throw error;
    }
  }

  /** Recreates the session so persisted configuration changes take effect. */
  async restartSession() {
    if (!this.isEnabled) {
      return;
    }

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
