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
import {test, type TestContext} from 'node:test';
import type {BashOperations, ExtensionAPI} from '@earendil-works/pi-coding-agent';
import zshrc from '../agent/extensions/zshrc.ts';

void test('loads zsh aliases before parsing host user commands', async (t: TestContext) => {
  type Handler = (event: {command: string}) => {operations: BashOperations} | undefined;
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-user-shell-test-'));
  const shellPath = join(directory, 'zsh');
  let completedCommand: unknown;
  let handler: Handler | undefined;

  try {
    await writeFile(shellPath, '#!/bin/sh\nprintf %s "$2"\n');
    await chmod(shellPath, 0o755);
    t.mock.property(process, 'env', {...process.env, SHELL: shellPath});

    zshrc({
      events: {
        emit(channel: string, data: unknown) {
          if (channel === 'sloppi:user-bash-end') {
            completedCommand = data;
          }
        },
      },
      on(name: string, candidate: Handler) {
        if (name === 'user_bash') {
          handler = candidate;
        }
      },
    } as unknown as ExtensionAPI);

    if (handler === undefined) {
      throw new Error('user_bash handler was not registered');
    }

    let output = '';
    const result = handler({command: 'glol \'quoted\''});
    await result?.operations.exec('ignored prefix', process.cwd(), {
      onData(data) {
        output += data.toString();
      },
    });

    t.assert.match(output, /^source ~\/\.zshrc\neval -- /v);
    t.assert.match(output, /glol '"'"'quoted'"'"'/v);
    t.assert.doesNotMatch(output, /ignored prefix/v);
    await waitForImmediate();
    t.assert.strictEqual(completedCommand, 'glol \'quoted\'');
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
