import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolExecutionEndEvent,
  UserBashEvent,
  UserBashEventResult,
} from '@earendil-works/pi-coding-agent';
import atuin from '../agent/extensions/atuin.ts';
import zshrc from '../agent/extensions/zshrc.ts';

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>;
type ToolEndHandler = (event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void>;
type UserBashHandler = (event: UserBashEvent, ctx: ExtensionContext) => UserBashEventResult | undefined | Promise<UserBashEventResult | undefined>;

type AtuinHarness = {
  calls: Array<{arguments: string[]; cwd: string}>;
  api: ExtensionAPI;
  toolCall: ToolCallHandler;
  toolEnd: ToolEndHandler;
  userBash: UserBashHandler;
};

/**
Creates the smallest extension runtime needed to exercise Atuin's lifecycle.
History starts receive deterministic IDs, while every invocation is retained so
tests can verify command text, working directory, and final status together.
*/
function createHarness(isZshFirst?: boolean): AtuinHarness {
  let nextId = 0;
  let toolCall: ToolCallHandler | undefined;
  let toolEnd: ToolEndHandler | undefined;
  const userBashHandlers: UserBashHandler[] = [];
  const bus = new Map<string, (value: unknown) => void>();
  const calls: Array<{arguments: string[]; cwd: string}> = [];

  const api = {
    events: {
      emit(channel: string, value: unknown) {
        bus.get(channel)?.(value);
      },
      on(channel: string, listener: (value: unknown) => void) {
        bus.set(channel, listener);

        return () => undefined;
      },
    },
    async exec(command: string, arguments_: string[], options: {cwd?: string}) {
      if (command !== 'atuin') {
        throw new Error(`Unexpected executable: ${command}`);
      }

      calls.push({arguments: arguments_, cwd: options.cwd ?? ''});
      if (arguments_[1] === 'start') {
        nextId += 1;
        return {code: 0, stderr: '', stdout: `history-${nextId}\n`};
      }

      return {code: 0, stderr: '', stdout: ''};
    },
    on(name: string, handler: ToolCallHandler | ToolEndHandler | UserBashHandler) {
      switch (name) {
        case 'tool_call': {
          toolCall = handler as ToolCallHandler;
          break;
        }

        case 'tool_execution_end': {
          toolEnd = handler as ToolEndHandler;
          break;
        }

        case 'user_bash': {
          userBashHandlers.push(handler as UserBashHandler);
          break;
        }

        default:
      }

      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  if (isZshFirst === true) {
    zshrc(api);
  }

  atuin(api);
  if (isZshFirst === false) {
    zshrc(api);
  }

  if (toolCall === undefined || toolEnd === undefined || userBashHandlers.length === 0) {
    throw new Error('Atuin lifecycle handlers were not registered');
  }

  return {
    calls,
    api,
    toolCall,
    toolEnd,
    /**
    Mirrors Pi's short-circuit dispatch so regression tests do not accidentally
    invoke Atuin after the zsh extension has already claimed the user command.
    */
    async userBash(event, ctx) {
      for (const handler of userBashHandlers) {
        // Pi dispatches serially and stops after the first replacement result.
        // eslint-disable-next-line no-await-in-loop
        const result = await handler(event, ctx);
        if (result !== undefined) {
          return result;
        }
      }

      return undefined;
    },
  };
}

void describe('Atuin history', () => {
  void test('records Bash tools with final exit codes', async (t: TestContext) => {
    t.mock.property(process, 'env', {...process.env, SHELL: '/bin/zsh'});
    const harness = createHarness();
    const context = {cwd: '/agent-worktree'} as unknown as ExtensionContext;

    await harness.toolCall({
      input: {command: 'npm test'},
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool_call',
    }, context);
    await harness.toolEnd({
      isError: true,
      result: {content: [{text: 'tests failed\nCommand exited with code 7'}]},
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool_execution_end',
    }, context);

    t.assert.deepStrictEqual(harness.calls, [
      {
        arguments: ['history', 'start', '--author', 'pi', '--author-kind', 'agent', '--', 'npm test'],
        cwd: '/agent-worktree',
      },
      {arguments: ['history', 'end', 'history-1', '--exit', '7'], cwd: '/agent-worktree'},
    ]);
  });

  void test('wraps non-zsh user commands and records their real result', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-atuin-test-'));
    const shellPath = join(directory, 'test-shell');

    try {
      await writeFile(shellPath, '#!/bin/sh\nexit 6\n');
      await chmod(shellPath, 0o755);
      t.mock.property(process, 'env', {...process.env, SHELL: shellPath});
      const harness = createHarness();
      const context = {cwd: directory} as unknown as ExtensionContext;
      const result = await harness.userBash({
        command: 'ignored by test shell',
        cwd: directory,
        excludeFromContext: true,
        type: 'user_bash',
      }, context);

      if (result?.operations === undefined) {
        throw new Error('Atuin did not provide non-zsh Bash operations');
      }

      const execution = await result.operations.exec('ignored by test shell', directory, {
        onData() {
          return undefined;
        },
      });

      t.assert.strictEqual(execution.exitCode, 6);
      t.assert.deepStrictEqual(harness.calls.at(-1), {
        arguments: ['history', 'end', 'history-1', '--exit', '6'],
        cwd: directory,
      });
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  for (const isZshFirst of [true, false]) {
    for (const isExcludedFromContext of [true, false]) {
      void test(`records ggp as user history with zsh loaded ${isZshFirst ? 'first' : 'last'} and !! = ${isExcludedFromContext}`, async (t: TestContext) => {
        const directory = await mkdtemp(join(tmpdir(), 'sloppi-atuin-zsh-test-'));
        const shellPath = join(directory, 'zsh');

        try {
          // Emulate the alias-aware shell without sourcing the real user's rc file
          // or running a Git push. The command still crosses Pi's process boundary.
          await writeFile(shellPath, [
            '#!/bin/sh',
            'script=$(printf %s "$2" | tail -n +2 | cut -c 9-)',
            'ggp() { printf pushed; return 7; }',
            'eval "eval $script"',
            '',
          ].join('\n'));
          await chmod(shellPath, 0o755);
          t.mock.property(process, 'env', {...process.env, SHELL: shellPath});
          const harness = createHarness(isZshFirst);
          const context = {cwd: directory} as unknown as ExtensionContext;
          const result = await harness.userBash({
            command: 'ggp',
            cwd: directory,
            excludeFromContext: isExcludedFromContext,
            type: 'user_bash',
          }, context);
          if (result?.operations === undefined) {
            throw new Error('zsh operations were not installed');
          }

          let output = '';
          const execution = await result.operations.exec('ggp', directory, {
            onData(data) {
              output += data.toString();
            },
          });
          t.assert.strictEqual(output, 'pushed');
          t.assert.strictEqual(execution.exitCode, 7);
          t.assert.deepStrictEqual(harness.calls, [
            {arguments: ['history', 'start', '--author-kind', 'user', '--', 'ggp'], cwd: directory},
            {arguments: ['history', 'end', 'history-1', '--exit', '7'], cwd: directory},
          ]);
        } finally {
          await rm(directory, {force: true, recursive: true});
        }
      });
    }
  }
});
