import {Buffer} from 'node:buffer';
import process from 'node:process';
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
import {formatSandboxError, type Sandbox} from './sandbox.ts';

type FindArgumentsInput = {
  platform: string;
  pattern: string;
  path: string;
  ignore: readonly string[];
  limit: number;
};

export function getFindArguments({platform, pattern, path, ignore, limit}: FindArgumentsInput): string[] {
  if (platform === 'darwin') {
    const name = pattern.includes('/') ? '-path' : '-name';
    const match = name === '-path' ? `*${pattern}` : pattern;
    return [
      'find',
      path,
      '-type',
      'f',
      ...ignore.flatMap(entry => ['!', '-path', `*${entry}`]),
      name,
      match,
      '-print',
    ];
  }

  return [
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
  ];
}

export function registerSandboxTools(pi: ExtensionAPI, cwd: string, sandbox: Sandbox): BashOperations {
  const read: ReadOperations = {
    async access(path) {
      await sandbox.run(['test', '-r', path]);
    },
    async readFile(path) {
      const output = await sandbox.run(['sh', '-c', String.raw`base64 < "$1" | tr -d "\n"`, 'sh', path]);
      return Buffer.from(output, 'base64');
    },
    async detectImageMimeType(path) {
      const output = await sandbox.run(['file', '--mime-type', '-b', '--', path]);
      const mime = output.trim();
      return ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null;
    },
  };

  const write: WriteOperations = {
    async mkdir(path) {
      await sandbox.run(['mkdir', '-p', '--', path]);
    },
    async writeFile(path, content) {
      await sandbox.run(['sh', '-c', 'cat > "$1"', 'sh', path], {input: content});
    },
  };

  const edit: EditOperations = {
    ...read,
    ...write,
    async access(path) {
      await sandbox.run(['sh', '-c', 'test -r "$1" && test -w "$1"', 'sh', path]);
    },
  };

  const bash: BashOperations = {
    async exec(command, _commandCwd, {onData, signal, timeout}) {
      const result = await sandbox.shell(['sh', '-lc', command], {debugSandbox: true, signal, timeout});
      onData(Buffer.from(result.stdout));

      const blocked = /\[SandboxDebug\] No matching config rule, denying: (?<domain>\S+)/v.exec(result.stderr)?.groups?.domain;
      let isDebugBlock = false;
      const cleanStderr = result.stderr
        .split('\n')
        .filter(line => {
          if (line.startsWith('[SandboxDebug]')) {
            isDebugBlock = line.endsWith('{');
            return false;
          }

          if (isDebugBlock) {
            isDebugBlock = line !== '}';
            return false;
          }

          return true;
        })
        .join('\n')
        .trim();
      const annotatedStderr = blocked === undefined
        ? cleanStderr
        : `${cleanStderr}\n<sandbox_violations>\ndeny network-outbound ${blocked} (host is not on the allow list)\n</sandbox_violations>`;
      const stderr = result.exitCode === 0
        ? annotatedStderr
        : formatSandboxError(annotatedStderr, `Sandbox command failed (${String(result.exitCode)})`);
      onData(Buffer.from(stderr));
      return {exitCode: result.exitCode ?? null};
    },
  };

  const find: FindOperations = {
    async exists(path) {
      const result = await sandbox.shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async glob(pattern, path, {ignore, limit}) {
      const output = await sandbox.run(getFindArguments({
        platform: process.platform,
        pattern,
        path,
        ignore,
        limit,
      }));
      const results = output.trim().split('\n').filter(Boolean);
      return process.platform === 'darwin' ? results.slice(0, limit) : results;
    },
  };

  const ls: LsOperations = {
    async exists(path) {
      const result = await sandbox.shell(['test', '-e', path]);
      return result.exitCode === 0;
    },
    async stat(path) {
      const exists = await sandbox.shell(['test', '-e', path]);
      if (exists.exitCode !== 0) {
        throw new Error(`Path not found: ${path}`);
      }

      const directory = await sandbox.shell(['test', '-d', path]);
      return {isDirectory: () => directory.exitCode === 0};
    },
    async readdir(path) {
      const output = await sandbox.run(['ls', '-1A', '--', path]);
      return output.trim().split('\n').filter(Boolean);
    },
  };

  pi.registerTool(createReadTool(cwd, {operations: read}));
  pi.registerTool(createWriteTool(cwd, {operations: write}));
  pi.registerTool(createEditTool(cwd, {operations: edit}));
  pi.registerTool(createBashTool(cwd, {operations: bash, exposeSessionEnvironment: false}));
  pi.registerTool(createFindTool(cwd, {operations: find}));
  pi.registerTool(createLsTool(cwd, {operations: ls}));

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

      const result = await sandbox.shell(arguments_, {signal});
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(formatSandboxError(result.stderr.trim(), `rg failed (${String(result.exitCode)})`));
      }

      const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
      return {
        content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}],
        details: undefined,
      };
    },
  });

  return bash;
}
