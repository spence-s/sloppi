import {Buffer} from 'node:buffer';
import {realpathSync} from 'node:fs';
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
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import type {SandboxSessionManager} from './session-manager.ts';

// Reuse Pi's exact execute signature so this replacement cannot drift from the tool it overrides.
type GrepExecute = ReturnType<typeof createGrepTool>['execute'];

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

   Pi cannot currently inject a sandboxed process into its built-in grep tool, so this
   execute function stays local until https://github.com/earendil-works/pi/issues/5354
   is resolved. Ripgrep's `--max-count` is deliberately not used: it limits each file,
   while Pi's `limit` promises a limit across the entire search.
   */
  get grepExecute(): GrepExecute {
    const {sandbox} = this;
    // eslint-disable-next-line complexity -- search, formatting, and errors stay together to keep the flow readable.
    return async (_id, {pattern, path = '.', glob, ignoreCase, literal, context, limit = 100}, signal) => {
      /*
       JSON output gives every record an explicit event type. Plain-text output cannot
       reliably distinguish a match from a requested context line, so it cannot enforce
       a match limit correctly.

       `--line-number` keeps the required source location in each event. `--color=never`
       prevents terminal escape codes from entering model-visible text. `--hidden` matches
       Pi's native grep behavior, while the two negative globs keep repository metadata and
       dependencies out of broad default searches.
       */
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
      // Add optional flags only when requested so ripgrep's normal defaults remain intact.
      if (ignoreCase === true) {
        arguments_.push('--ignore-case');
      }

      // Fixed-string mode treats regex characters such as `.` and `*` literally.
      if (literal === true) {
        arguments_.push('--fixed-strings');
      }

      // Passing the glob as its own argument avoids shell interpolation and quoting problems.
      if (glob !== undefined) {
        arguments_.push('--glob', glob);
      }

      // `--` ends option parsing, so a pattern or path beginning with a dash stays data.
      arguments_.push('--', pattern, path);

      /*
       Pi's schema accepts JSON numbers, but partial and negative line counts have no useful
       meaning. Flooring makes the behavior deterministic; clamping keeps at least one match
       and prevents negative context windows.
       */
      const effectiveLimit = Math.max(1, Math.floor(limit));
      const contextLines = Math.max(0, Math.floor(context ?? 0));

      // Store only fields needed for final output; JSON metadata is discarded immediately.
      const matches: Array<{path: string; lineNumber: number; text: string}> = [];

      /*
       There are two independent reasons to stop ripgrep:
       1. Pi may cancel the tool call through `signal`.
       2. This function must stop after collecting the requested number of matches.

       `AbortSignal.any` lets either source terminate the same sandboxed process. We keep the
       private controller separate so the catch block can distinguish successful limit-driven
       cancellation from a user-visible abort.
       */
      const limitController = new AbortController();
      const runSignal = signal === undefined
        ? limitController.signal
        : AbortSignal.any([signal, limitController.signal]);
      let didReachMatchLimit = false;

      /*
       Process streams arrive as arbitrary byte chunks, not as complete lines or characters.
       `pendingJson` holds an incomplete JSON line between chunks. Streaming TextDecoders also
       preserve a multi-byte UTF-8 character when its bytes are split across two chunks.
       */
      let pendingJson = '';
      let stderr = '';
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();

      // A limit-driven abort rejects `sandbox.run`, so no result object exists on that path.
      let result;

      try {
        result = await sandbox.run({
          // Resolve relative search paths exactly as other sandboxed commands do.
          cwd: sandbox.cwd,
          signal: runSignal,
          onStdout(data) {
            /*
             Calling `abort()` asks the operating system to stop the process, but data already
             waiting in Node's event queue may still invoke this callback. Ignoring those chunks
             prevents the stored match count from slipping past the promised limit.
             */
            if (didReachMatchLimit) {
              return;
            }

            /*
             Append decoded text to the unfinished previous chunk, then split complete JSON Lines.
             `pop()` removes the final item because it may be only the beginning of the next event;
             a trailing newline naturally leaves an empty string, which is also safe to retain.
             */
            const lines = `${pendingJson}${stdoutDecoder.decode(data, {stream: true})}`.split('\n');
            pendingJson = lines.pop() ?? '';

            for (const line of lines) {
              // Ripgrep normally emits no blank records, but skipping one is harmless and explicit.
              if (line.length === 0) {
                continue;
              }

              // Ripgrep owns this JSON shape; optional fields still protect binary/path events.
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
              const event = JSON.parse(line) as RipgrepEvent;
              const eventPath = event.data?.path?.text;
              const lineNumber = event.data?.line_number;
              const text = event.data?.lines?.text;

              /*
               Ignore lifecycle, context, summary, and non-text events. Counting only explicit
               `match` events is the key difference from piping plain output through `head`.
               */
              if (event.type !== 'match'
                || eventPath === undefined
                || lineNumber === undefined
                || text === undefined) {
                continue;
              }

              matches.push({path: eventPath, lineNumber, text});
              if (matches.length >= effectiveLimit) {
                /*
                 Stop at the limit rather than reading the entire repository and slicing later.
                 This bounds the match array, ripgrep's remaining filesystem work, and the amount
                 of JSON crossing the process boundary.
                 */
                didReachMatchLimit = true;
                limitController.abort();
                break;
              }
            }
          },
          onStderr(data) {
            /*
             `sandbox.run` disables Execa's built-in buffering whenever callbacks consume streams.
             Keep stderr ourselves so ripgrep and sandbox policy failures still produce useful errors.
             */
            stderr += stderrDecoder.decode(data, {stream: true});
          },
        })`${arguments_}`;
      } catch (error) {
        // An abort requested by Pi must remain visible to Pi even if matches were already collected.
        if (signal?.aborted === true) {
          throw new Error('Operation aborted', {cause: error});
        }

        /*
         Reaching the limit intentionally cancels the process, and Execa reports cancellation by
         rejecting. Swallow only that expected rejection; every other launch/runtime error remains
         a real tool failure.
         */
        if (!didReachMatchLimit) {
          throw error;
        }
      }

      /*
       Ripgrep uses exit code 0 for matches and 1 for a clean search with no matches. Any other
       completed exit is an error. The check is skipped after our cancellation because an aborted
       process has no meaningful normal exit code.
       */
      if (!didReachMatchLimit && result?.exitCode !== 0 && result?.exitCode !== 1) {
        const diagnostic = stderr.trim();
        let error = diagnostic.length > 0 ? diagnostic : `rg failed (${String(result?.exitCode)})`;
        // Add recovery guidance when the useful low-level error is specifically a sandbox denial.
        if (/operation not permitted|<sandbox_violations>|connection blocked by network allowlist/iv.test(error)) {
          error += `\n\n${[
            'SandboxSessionManager restriction: work in the current project, use mktemp for private temporary files,',
            'and treat global skills as read-only. Network access is limited by the configured allowlist.',
            'Do not retry an outside path or seek a host-execution workaround.',
          ].join(' ')}`;
        }

        throw new Error(error);
      }

      // Keep Pi's standard no-match response so the model does not mistake empty output for failure.
      if (matches.length === 0) {
        return {content: [{type: 'text' as const, text: 'No matches found'}], details: undefined};
      }

      /*
       Context is reconstructed after ripgrep stops instead of requesting `rg --context` output.
       Otherwise canceling on the final match could remove its following context lines, and counting
       plain output would again confuse context with matches.
       */
      // Multiple matches often share a file; cache it so context requires only one sandboxed read.
      const fileCache = new Map<string, string[]>();
      const outputLines: string[] = [];
      let wereLinesTruncated = false;
      for (const match of matches) {
        if (contextLines === 0) {
          // JSON match text includes its line ending; normalize it before creating one output row.
          const line = match.text.replace(/\r?\n$/v, '').replaceAll('\r', '');
          // Pi caps individual lines independently from the final total-byte cap.
          const truncated = truncateLine(line);
          wereLinesTruncated ||= truncated.wasTruncated;
          outputLines.push(`${match.path}:${match.lineNumber}: ${truncated.text}`);
          continue;
        }

        let fileLines = fileCache.get(match.path);
        if (fileLines === undefined) {
          try {
            /*
             Context reads stay sequential so one grep cannot fan out into 100 processes.
             The normal read operation is reused because it already applies the sandbox policy.
             */
            // eslint-disable-next-line no-await-in-loop
            const contents = await this.readOperations.readFile(match.path);

            // Normalize Windows and old-Mac line endings so line-number indexing is predictable.
            fileLines = contents.toString().replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
          } catch {
            // A file may disappear between the search and context read; preserve the match below.
            fileLines = [];
          }

          // Cache failures too, preventing repeated attempts for several matches in one missing file.
          fileCache.set(match.path, fileLines);
        }

        if (fileLines.length === 0) {
          // The location remains useful even when context cannot be recovered.
          outputLines.push(`${match.path}:${match.lineNumber}: (unable to read file)`);
          continue;
        }

        // Clamp the context window at the beginning and end of the file.
        const firstLine = Math.max(1, match.lineNumber - contextLines);
        const lastLine = Math.min(fileLines.length, match.lineNumber + contextLines);
        for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
          // Source line numbers are one-based, while JavaScript arrays are zero-based.
          const truncated = truncateLine(fileLines[lineNumber - 1] ?? '');
          wereLinesTruncated ||= truncated.wasTruncated;

          // Colons identify the match; dashes identify surrounding context, matching ripgrep/Pi.
          const separator = lineNumber === match.lineNumber ? ':' : '-';
          outputLines.push(`${match.path}${separator}${String(lineNumber)}${separator} ${truncated.text}`);
        }
      }

      /*
       Context expansion and long paths can still make a small number of matches very large. Apply
       Pi's shared byte cap after formatting. The line cap is disabled because the match limit, not
       the number of context rows, defines grep's row semantics.
       */
      const truncation = truncateHead(outputLines.join('\n'), {maxLines: Number.MAX_SAFE_INTEGER});

      /*
       `details` feeds Pi's TUI renderer, while notices are appended to tool text so the model also
       knows that its view is incomplete and can refine the next search.
       */
      const details: GrepToolDetails = {};
      const notices: string[] = [];
      if (didReachMatchLimit) {
        details.matchLimitReached = effectiveLimit;
        notices.push(`${String(effectiveLimit)} matches limit reached. Refine the pattern or increase limit`);
      }

      // Preserve the full truncation object because Pi uses it to render the byte-limit warning.
      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }

      // Tell callers when individual source lines were shortened before total output truncation.
      if (wereLinesTruncated) {
        details.linesTruncated = true;
        notices.push('Some lines truncated. Use read to see full lines');
      }

      // Put all warnings in one final bracketed paragraph, following Pi's built-in tool format.
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
