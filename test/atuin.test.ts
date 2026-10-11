import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {setImmediate as waitForImmediate} from 'node:timers/promises';
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

type ToolCallHandler = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>;
type ToolEndHandler = (event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void>;
type UserBashHandler = (event: UserBashEvent, ctx: ExtensionContext) => Promise<UserBashEventResult | undefined>;

type AtuinHarness = {
  calls: Array<{arguments: string[]; cwd: string}>;
  completeUserBash(value: unknown): void;
  toolCall: ToolCallHandler;
  toolEnd: ToolEndHandler;
  userBash: UserBashHandler;
};

/**
Creates the smallest extension runtime needed to exercise Atuin's lifecycle.
History starts receive deterministic IDs, while every invocation is retained so
tests can verify command text, working directory, and final status together.
*/
function createHarness(): AtuinHarness {
  let nextId = 0;
  let toolCall: ToolCallHandler | undefined;
  let toolEnd: ToolEndHandler | undefined;
  let userBash: UserBashHandler | undefined;
  let completeUserBash: ((value: unknown) => void) | undefined;
  const calls: Array<{arguments: string[]; cwd: string}> = [];

  atuin({
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        if (channel === 'sloppi:user-bash-result') {
          completeUserBash = listener;
        }

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
          userBash = handler as UserBashHandler;
          break;
        }

        default:
      }

      return () => undefined;
    },
  } as unknown as ExtensionAPI);

  if (toolCall === undefined || toolEnd === undefined || userBash === undefined || completeUserBash === undefined) {
    throw new Error('Atuin lifecycle handlers were not registered');
  }

  return {
    calls,
    completeUserBash,
    toolCall,
    toolEnd,
    userBash,
  };
}

void describe('Atuin history', () => {
  void test('records Bash tools and zsh user commands with final exit codes', async (t: TestContext) => {
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

    const userResult = await harness.userBash({
      command: 'git status',
      cwd: '/user-worktree',
      excludeFromContext: false,
      type: 'user_bash',
    }, context);
    t.assert.strictEqual(userResult, undefined);
    harness.completeUserBash({command: 'git status', cwd: '/user-worktree', exitCode: 9});
    await waitForImmediate();

    t.assert.deepStrictEqual(harness.calls, [
      {
        arguments: ['history', 'start', '--author', 'pi', '--author-kind', 'agent', '--', 'npm test'],
        cwd: '/agent-worktree',
      },
      {arguments: ['history', 'end', 'history-1', '--exit', '7'], cwd: '/agent-worktree'},
      {
        arguments: ['history', 'start', '--author', 'pi', '--author-kind', 'agent', '--', 'git status'],
        cwd: '/user-worktree',
      },
      {arguments: ['history', 'end', 'history-2', '--exit', '9'], cwd: '/user-worktree'},
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
});
