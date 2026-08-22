import {Buffer} from 'node:buffer';
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
  type GrepOperations,
} from '@earendil-works/pi-coding-agent';
import type {SandboxSessionManager} from './session-manager.ts';

type GrepExecute = ReturnType<typeof createGrepTool>['execute'];

export class SandboxTools {
  pi: ExtensionAPI;
  cwd: string;
  sandbox: SandboxSessionManager;

  constructor(pi: ExtensionAPI, cwd: string, sandbox: SandboxSessionManager) {
    this.pi = pi;
    this.cwd = cwd;
    this.sandbox = sandbox;
  }

  get readOperations(): ReadOperations {
    const {sandbox} = this;
    return {
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
  }

  get writeOperations(): WriteOperations {
    const {sandbox} = this;
    return {
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
  }

  get editOperations(): EditOperations {
    const {sandbox} = this;
    return {
      ...this.readOperations,
      ...this.writeOperations,
      async access(path) {
        const result = await sandbox.run`test -r ${path} && test -w ${path}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot edit ${path}`);
        }
      },
    };
  }

  get bashOperations(): BashOperations {
    const {sandbox} = this;
    return {
      async exec(command, commandCwd, {onData}) {
        const result = await sandbox.run({cwd: commandCwd})`sh -c ${command}`;
        onData(Buffer.from(result.stdout));
        onData(Buffer.from(result.stderr));
        return {exitCode: result.exitCode ?? null};
      },
    };
  }

  // https://github.com/earendil-works/pi/issues/5354
  get grepExecute(): GrepExecute {
    const {sandbox} = this;
    return async (_id, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}) => {
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
            'SandboxSessionManager restriction: work in the current project, use mktemp for private temporary files,',
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
    };
  }

  get findOperations(): FindOperations {
    const {sandbox} = this;
    return {
      async exists(path) {
        const result = await sandbox.run`test -e ${path}`;
        return result.exitCode === 0;
      },
      async glob(pattern, path, {ignore, limit}) {
        const name = pattern.includes('/') ? '-path' : '-name';
        const match = name === '-path' ? `*${pattern}` : pattern;
        const result = await sandbox.run`${['find', path, '-type', 'f', ...ignore.flatMap(entry => ['!', '-path', `*${entry}`]), name, match, '-print']}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot find ${pattern}`);
        }

        const results = result.stdout.trim().split('\n').filter(Boolean);
        return results.slice(0, limit);
      },
    };
  }

  get lsOperations(): LsOperations {
    const {sandbox} = this;
    return {
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
  }

  get read(): ReturnType<typeof createReadTool> {
    return createReadTool(this.cwd, {operations: this.readOperations});
  }

  get write(): ReturnType<typeof createWriteTool> {
    return createWriteTool(this.cwd, {operations: this.writeOperations});
  }

  get edit(): ReturnType<typeof createEditTool> {
    return createEditTool(this.cwd, {operations: this.editOperations});
  }

  get bash(): ReturnType<typeof createBashTool> {
    return createBashTool(this.cwd, {operations: this.bashOperations, exposeSessionEnvironment: false});
  }

  get find(): ReturnType<typeof createFindTool> {
    return createFindTool(this.cwd, {operations: this.findOperations});
  }

  get ls(): ReturnType<typeof createLsTool> {
    return createLsTool(this.cwd, {operations: this.lsOperations});
  }

  // https://github.com/earendil-works/pi/issues/5354
  get grep(): ReturnType<typeof createGrepTool> {
    return {...createGrepTool(this.cwd), execute: this.grepExecute};
  }

  register(): void {
    this.pi.registerTool(this.read);
    this.pi.registerTool(this.write);
    this.pi.registerTool(this.edit);
    this.pi.registerTool(this.bash);
    this.pi.registerTool(this.find);
    this.pi.registerTool(this.ls);
    this.pi.registerTool(this.grep);
  }
}
