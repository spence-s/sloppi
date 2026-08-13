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
import type {Sandbox} from './sandbox.ts';

type FindArgumentsInput = {
  platform: string;
  pattern: string;
  path: string;
  ignore: readonly string[];
  limit: number;
};

export class SandboxTools {
  static getFindArguments({platform, pattern, path, ignore, limit}: FindArgumentsInput): string[] {
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

  pi: ExtensionAPI;
  cwd: string;
  sandbox: Sandbox;

  constructor(pi: ExtensionAPI, cwd: string, sandbox: Sandbox) {
    this.pi = pi;
    this.cwd = cwd;
    this.sandbox = sandbox;
  }

  register(): void {
    const {pi, cwd, sandbox} = this;
    const read: ReadOperations = {
      async access(path) {
        const result = await sandbox.run`test -r ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
        }
      },
      async readFile(path) {
        const result = await sandbox.run`base64 < ${path} | tr -d '\n'`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
        }

        return Buffer.from(result.stdout, 'base64');
      },
      async detectImageMimeType(path) {
        const result = await sandbox.run`file --mime-type -b -- ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot identify ${path}`);
        }

        const mime = result.stdout.trim();
        return ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null;
      },
    };

    const write: WriteOperations = {
      async mkdir(path) {
        const result = await sandbox.run`mkdir -p -- ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot create ${path}`);
        }
      },
      async writeFile(path, content) {
        const result = await sandbox.run`printf %s ${content} > ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot write ${path}`);
        }
      },
    };

    const edit: EditOperations = {
      ...read,
      ...write,
      async access(path) {
        const result = await sandbox.run`test -r ${path} && test -w ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot edit ${path}`);
        }
      },
    };

    const bash: BashOperations = {
      async exec(command, commandCwd, {onData}) {
        const result = await sandbox.run({cwd: commandCwd})`sh -lc ${command}`;
        onData(Buffer.from(result.stdout));
        onData(Buffer.from(result.stderr));
        return {exitCode: result.exitCode ?? null};
      },
    };

    const find: FindOperations = {
      async exists(path) {
        const result = await sandbox.run`test -e ${path}`;
        return result.exitCode === 0;
      },
      async glob(pattern, path, {ignore, limit}) {
        const result = await sandbox.run`${SandboxTools.getFindArguments({
          platform: process.platform,
          pattern,
          path,
          ignore,
          limit,
        })}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot find ${pattern}`);
        }

        const results = result.stdout.trim().split('\n').filter(Boolean);
        return process.platform === 'darwin' ? results.slice(0, limit) : results;
      },
    };

    const ls: LsOperations = {
      async exists(path) {
        const result = await sandbox.run`test -e ${path}`;
        return result.exitCode === 0;
      },
      async stat(path) {
        const exists = await sandbox.run`test -e ${path}`;
        if (exists.exitCode !== 0) {
          throw new Error(`Path not found: ${path}`);
        }

        const directory = await sandbox.run`test -d ${path}`;
        return {isDirectory: () => directory.exitCode === 0};
      },
      async readdir(path) {
        const result = await sandbox.run`ls -1A -- ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot list ${path}`);
        }

        return result.stdout.trim().split('\n').filter(Boolean);
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
      async execute(_id, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}) {
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

        const result = await sandbox.run`${arguments_}`;
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          const stderr = result.stderr.trim();
          let error = stderr.length > 0 ? stderr : `rg failed (${String(result.exitCode)})`;
          if (/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
            error += `\n\n${[
              'Sandbox restriction: work in the current project, use mktemp for private temporary files,',
              'and treat global skills as read-only. Network access is limited by the configured allowlist.',
              'Do not retry an outside path or seek a host-execution workaround.',
            ].join(' ')}`;
          }

          throw new Error(error);
        }

        const output = result.stdout.trim().split('\n').filter(Boolean).slice(0, limit).join('\n');
        return {
          content: [{type: 'text' as const, text: output.length > 0 ? output : 'No matches found'}],
          details: undefined,
        };
      },
    });
  }
}
