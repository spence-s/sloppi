import {Buffer} from 'node:buffer';
import process from 'node:process';
import {$} from 'execa';
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
  type FindOperations,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';

// Only these tools may execute commands; everything else stays explicitly allowlisted.
const remoteTools = new Set(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
// These provider-backed tools intentionally stay on the credential-holding host.
const hostTools = new Set(['fetch_content', 'get_search_content', 'source_check', 'web_search']);

// Pi passes cancellation and time limits through to the guest process.
type RunOptions = {
  input?: string | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
};

export const registerLimaTools = (pi: ExtensionAPI, instance: string, cwd: string): void => {
  // Every filesystem operation crosses this Lima boundary; failures never run locally.
  const shell = async (arguments_: string[], options: RunOptions = {}) => $({
    reject: false,
    ...(options.input !== undefined && {input: options.input}),
    ...(options.signal !== undefined && {cancelSignal: options.signal}),
    ...(options.timeout !== undefined && {timeout: options.timeout * 1000}),
  })`limactl shell --tty=false --workdir ${cwd} ${instance} -- ${arguments_}`;

  const run = async (arguments_: string[], options?: RunOptions) => {
    const result = await shell(arguments_, options);
    if (result.exitCode !== 0) {
      const message = result.stderr.trim();
      throw new Error(message.length > 0 ? message : `Lima command failed (${String(result.exitCode)})`);
    }

    return result.stdout;
  };

  // Reuse Pi's rich read tool while performing its primitive I/O in Lima.
  const read: ReadOperations = {
    async access(path) {
      await run(['test', '-r', path]);
    },
    async readFile(path) {
      // Lima stdout is text; base64 preserves binary files and image support.
      const output = await run(['base64', '-w', '0', '--', path]);
      return Buffer.from(output, 'base64');
    },
    // Pi asks before loading images so ordinary files remain ordinary text reads.
    async detectImageMimeType(path) {
      const output = await run(['file', '--mime-type', '-b', '--', path]);
      const mime = output.trim();
      return ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null;
    },
  };
  // Write stdin directly in Lima so content is never embedded in a shell command.
  const write: WriteOperations = {
    async mkdir(path) {
      await run(['mkdir', '-p', '--', path]);
    },
    async writeFile(path, content) {
      await run(['sh', '-c', 'cat > "$1"', 'sh', path], {input: content});
    },
  };
  // Pi computes and renders the edit diff; Lima only reads and writes the file.
  const edit: EditOperations = {
    ...read,
    ...write,
    async access(path) {
      await run(['sh', '-c', 'test -r "$1" && test -w "$1"', 'sh', path]);
    },
  };
  // Bash returns nonzero exit codes to Pi instead of treating them as transport failures.
  const bash: BashOperations = {
    async exec(command, _commandCwd, {onData, signal, timeout}) {
      const result = await shell(['sh', '-lc', command], {signal, timeout});
      onData(Buffer.from(result.stdout));
      onData(Buffer.from(result.stderr));
      return {exitCode: result.exitCode ?? null};
    },
  };
  // Pi owns find's globbing, limits, and rendering; Lima supplies its filesystem operations.
  const find: FindOperations = {
    async exists(path) {
      const result = await shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async glob(pattern, path, {ignore, limit}) {
      const output = await run([
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
      ]);
      return output.trim().split('\n').filter(Boolean);
    },
  };
  // Pi owns ls formatting, sorting, and limits; Lima supplies its filesystem operations.
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

  // GrepOperations do not own rg, so run the entire search in Lima instead.
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
        const message = result.stderr.trim();
        throw new Error(message.length > 0 ? message : `rg failed (${String(result.exitCode)})`);
      }

      const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
      return {
        content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}],
        details: undefined,
      };
    },
  });

  // User `!` commands use the same VM boundary as agent bash calls.
  pi.on('user_bash', () => ({operations: bash}));
  // Project resources must not execute inside the host Pi process.
  pi.on('project_trust', () => ({trusted: 'no'}));
  // Fail closed if Pi exposes a tool this extension has not explicitly routed or approved.
  pi.on('tool_call', event => {
    if (!remoteTools.has(event.toolName) && !hostTools.has(event.toolName)) {
      return {block: true, reason: `Tool ${event.toolName} is not approved for host execution.`};
    }
  });
  // Make the active execution boundary visible without exposing connection details.
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.setStatus('0:lima', ctx.ui.theme.fg('accent', `Lima: ${instance}`));
  });
};

// Outside Sloppi, loading this extension changes nothing.
const limaTools = (pi: ExtensionAPI): void => {
  const instance = process.env.SLOPPI_LIMA_INSTANCE;
  if (instance !== undefined) {
    registerLimaTools(pi, instance, process.cwd());
  }
};

export default limaTools;
