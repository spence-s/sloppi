import {Buffer} from 'node:buffer';
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {
  basename,
  isAbsolute,
  matchesGlob,
  resolve,
} from 'node:path';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type FindOperations,
  type GrepToolDetails,
  type LsToolDetails,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type {SandboxSessionManager} from './session-manager.ts';

// Reuse Pi's exact execute signature so this replacement cannot drift from the tool it overrides.
type GrepExecute = ReturnType<typeof createGrepTool>['execute'];
type LsExecute = ReturnType<typeof createLsTool>['execute'];

/**
 Describes only the part of an `rg --json` event used below.

 Every field is optional because ripgrep emits several event kinds (`begin`, `match`,
 `context`, `end`, and `summary`), and some paths or lines may be encoded as raw bytes
 instead of text. We ignore events that do not contain the three text fields needed to
 produce Pi's normal `path:line: text` output.
 */
type RipgrepEvent = {
  type?: string;
  data?: {
    path?: {text?: string};
    lines?: {text?: string};
    line_number?: number;
  };
};

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
        const result = await sandbox.run`test -r ${realpathSync(path)}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
        }
      },
      async readFile(path) {
        const result = await sandbox.run`base64 < ${realpathSync(path)}`;
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot read ${path}`);
        }

        return Buffer.from(result.stdout, 'base64');
      },
      async detectImageMimeType(path) {
        const result = await sandbox.run`file --mime-type -b -- ${realpathSync(path)}`;
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
        const result = await sandbox.run({cwd: sandbox.cwd, input: content})`cat > ${path}`;
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
      async exec(command, commandCwd, {onData, signal, timeout}) {
        const result = await sandbox.run({
          cwd: commandCwd,
          onData(data) {
            onData(Buffer.from(data));
          },
          signal,
          timeout,
        })`sh -c ${command}`;
        return {exitCode: result.exitCode ?? null};
      },
    };
  }

  /**
   Runs ripgrep inside the sandbox while preserving Pi's global match limit.

   Plain output would let `head` count rows directly, but parsing `path:line:text` is
   ambiguous when filenames or source text contain separators. JSON preserves those field
   boundaries; its event format is documented at
   https://docs.rs/grep-printer/latest/grep_printer/struct.JSON.html.

   Match events are filtered before `head` so JSON lifecycle events do not count toward the
   limit. Context is reconstructed afterward because piping ripgrep's context output through
   `head` would count context rows as matches and could cut off the final match's trailing context.
   */
  get grepExecute(): GrepExecute {
    const {sandbox} = this;
    // eslint-disable-next-line complexity -- search, formatting, and errors stay together to keep the flow readable.
    return async (_id, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}, signal) => {
      const arguments_ = [
        'rg',
        '--json',
        '--line-number',
        '--color=never',
        '--hidden',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules/**',
      ];
      if (ignoreCase === true) {
        arguments_.push('--ignore-case');
      }

      if (literal === true) {
        arguments_.push('--fixed-strings');
      }

      if (glob !== undefined) {
        arguments_.push('--glob', glob);
      }

      arguments_.push('--', pattern, path);

      const effectiveLimit = Math.max(1, Math.floor(limit));
      const contextLines = Math.max(0, Math.floor(context ?? 0));
      let result;
      try {
        result = await sandbox.run({
          cwd: sandbox.cwd,
          signal,
          pipe: ['head', '-n', effectiveLimit],
          /**
           Keeps only complete match events so `head` counts matches rather than JSON records.
           */
          transformStdout(line) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const event = JSON.parse(line) as RipgrepEvent;
            const eventPath = event.data?.path?.text;
            const lineNumber = event.data?.line_number;
            const text = event.data?.lines?.text;
            if (event.type !== 'match'
              || eventPath === undefined
              || lineNumber === undefined
              || text === undefined) {
              return undefined;
            }

            return JSON.stringify({path: eventPath, lineNumber, text});
          },
        })`${arguments_}`;
      } catch (error) {
        if (signal?.aborted === true) {
          throw new Error('Operation aborted', {cause: error});
        }

        throw error;
      }

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        let error = result.stderr.trim().length > 0 ? result.stderr.trim() : `rg failed (${String(result.exitCode)})`;
        if (/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
          error += `\n\n${[
            'SandboxSessionManager restriction: work in the current project, use mktemp for private temporary files,',
            'and treat global skills as read-only. Network access is limited by the configured allowlist.',
            'Do not retry an outside path or seek a host-execution workaround.',
          ].join(' ')}`;
        }

        throw new Error(error);
      }

      // Parse only the bounded, compact match records returned by `head`, not ripgrep's full event stream.
      const matches = result.stdout.length === 0
        ? []
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        : result.stdout.split('\n').map(line => JSON.parse(line) as {path: string; lineNumber: number; text: string});
      if (matches.length === 0) {
        return {content: [{type: 'text' as const, text: 'No matches found'}], details: undefined};
      }

      const fileCache = new Map<string, string[]>();
      const outputLines: string[] = [];
      let wereLinesTruncated = false;
      /*
       Ripgrep does not cap output bytes, and `--max-columns` has no effect in JSON mode (see
       the JSON docs above). Truncate each source line so one minified file cannot hide every
       later match; the final `truncateHead` still enforces Pi's 50KB cap after context expands.
       */
      for (const match of matches) {
        if (contextLines === 0) {
          const line = match.text.replace(/\r?\n$/v, '').replaceAll('\r', '');
          const truncated = truncateLine(line);
          wereLinesTruncated ||= truncated.wasTruncated;
          outputLines.push(`${match.path}:${match.lineNumber}: ${truncated.text}`);
          continue;
        }

        let fileLines = fileCache.get(match.path);
        if (fileLines === undefined) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const contents = await this.readOperations.readFile(match.path);
            fileLines = contents.toString().replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
          } catch {
            fileLines = [];
          }

          fileCache.set(match.path, fileLines);
        }

        if (fileLines.length === 0) {
          outputLines.push(`${match.path}:${match.lineNumber}: (unable to read file)`);
          continue;
        }

        const firstLine = Math.max(1, match.lineNumber - contextLines);
        const lastLine = Math.min(fileLines.length, match.lineNumber + contextLines);
        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
          const truncated = truncateLine(fileLines[lineNumber - 1] ?? '');
          wereLinesTruncated ||= truncated.wasTruncated;
          const separator = lineNumber === match.lineNumber ? ':' : '-';
          outputLines.push(`${match.path}${separator}${String(lineNumber)}${separator} ${truncated.text}`);
        }
      }

      // Match count and output size are independent, especially when each match includes context.
      const truncation = truncateHead(outputLines.join('\n'), {maxLines: Number.MAX_SAFE_INTEGER});
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (matches.length >= effectiveLimit) {
        details.matchLimitReached = effectiveLimit;
        notices.push(`${String(effectiveLimit)} matches limit reached. Refine the pattern or increase limit`);
      }

      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }

      if (wereLinesTruncated) {
        details.linesTruncated = true;
        notices.push('Some lines truncated. Use read to see full lines');
      }

      const notice = notices.length > 0 ? `\n\n[${notices.join('. ')}]` : '';
      return {
        content: [{type: 'text' as const, text: `${truncation.content}${notice}`}],
        details: notices.length > 0 ? details : undefined,
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
        const arguments_ = [
          'rg',
          '--files',
          '--hidden',
          ...ignore.flatMap(entry => [
            '--glob',
            `!${entry}`,
            ...(entry.startsWith('**/') ? ['--glob', `!${entry.slice(3)}`] : []),
          ]),
          '--',
        ];
        const effectiveLimit = Math.max(0, Math.floor(limit));
        const result = await sandbox.run({
          cwd: path,
          pipe: ['head', '-n', effectiveLimit],
          transformStdout(candidate) {
            if (!pattern.includes('/')) {
              return matchesGlob(basename(candidate), pattern) ? candidate : undefined;
            }

            if (isAbsolute(pattern)) {
              return matchesGlob(resolve(path, candidate), pattern) ? candidate : undefined;
            }

            return matchesGlob(candidate, pattern) || matchesGlob(candidate, `**/${pattern}`)
              ? candidate
              : undefined;
          },
        })`${arguments_}`;
        if (result.exitCode !== 0 && result.exitCode !== 1) {
          throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot find ${pattern}`);
        }

        return result.stdout.trim().split('\n').filter(Boolean);
      },
    };
  }

  /**
   Lists a directory in one sandbox instead of spawning one sandbox per child stat.
   */
  get lsExecute(): LsExecute {
    const {cwd, sandbox} = this;
    return async (_toolCallId, {path, limit}, signal) => {
      const requestedPath = (path === undefined || path.length === 0 ? '.' : path)
        .replace(/^@/v, '')
        .replace(/^~(?=\/|$)/v, () => homedir());
      const directory = resolve(cwd, requestedPath);
      const effectiveLimit = Math.max(0, Math.floor(limit ?? 500));
      let entryCount = 0;
      let totalBytes = 0;
      let outputBytes = 0;
      let outputLines = 0;
      let hasReachedByteLimit = false;
      let result;
      try {
        result = await sandbox.run({
          cwd,
          signal,
          transformStdout(entry) {
            entryCount++;
            if (entryCount > effectiveLimit) {
              return undefined;
            }

            const entryBytes = Buffer.byteLength(entry);
            totalBytes += entryBytes + (entryCount > 1 ? 1 : 0);
            const nextOutputBytes = outputBytes + entryBytes + (outputLines > 0 ? 1 : 0);
            if (hasReachedByteLimit || nextOutputBytes > DEFAULT_MAX_BYTES) {
              hasReachedByteLimit = true;
              return undefined;
            }

            outputBytes = nextOutputBytes;
            outputLines++;
            return entry;
          },
        })`ls -1Ap -- ${`${directory}/`}`;
      } catch (error) {
        if (signal?.aborted === true) {
          throw new Error('Operation aborted', {cause: error});
        }

        throw error;
      }

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim().length > 0 ? result.stderr.trim() : `Cannot list ${directory}`);
      }

      if (entryCount === 0 || effectiveLimit === 0) {
        return {content: [{type: 'text' as const, text: '(empty directory)'}], details: undefined};
      }

      const details: LsToolDetails = {};
      const notices: string[] = [];
      if (entryCount > effectiveLimit) {
        details.entryLimitReached = effectiveLimit;
        notices.push(`${String(effectiveLimit)} entries limit reached. Use limit=${String(effectiveLimit * 2)} for more`);
      }

      if (hasReachedByteLimit) {
        details.truncation = {
          content: result.stdout,
          truncated: true,
          truncatedBy: 'bytes',
          totalLines: Math.min(entryCount, effectiveLimit),
          totalBytes,
          outputLines,
          outputBytes,
          lastLinePartial: false,
          firstLineExceedsLimit: outputLines === 0,
          maxLines: Number.MAX_SAFE_INTEGER,
          maxBytes: DEFAULT_MAX_BYTES,
        };
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }

      const notice = notices.length > 0 ? `\n\n[${notices.join('. ')}]` : '';
      return {
        content: [{type: 'text' as const, text: `${result.stdout}${notice}`}],
        details: notices.length > 0 ? details : undefined,
      };
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
    return {...createLsTool(this.cwd), execute: this.lsExecute};
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
