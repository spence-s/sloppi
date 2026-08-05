import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {test, type TestContext} from 'node:test';
import sandboxTools, {createSandboxConfig} from '../agent/extensions/sandbox-tools.ts';

void test('limits filesystem access to the project and session scratch directory', (t: TestContext) => {
  const config = createSandboxConfig('/Users/spencer/Projects/app', '/private/tmp/sloppi-123/tmp');

  t.assert.deepStrictEqual(config.network, {allowedDomains: [], deniedDomains: []});
  t.assert.deepStrictEqual(config.filesystem.allowRead, ['/Users/spencer/Projects/app']);
  t.assert.deepStrictEqual(config.filesystem.allowWrite, [
    '/Users/spencer/Projects/app',
    '/private/tmp/sloppi-123/tmp',
  ]);
  t.assert.deepStrictEqual(config.filesystem.denyWrite, []);
  const userDirectory = dirname(homedir());
  t.assert.ok(config.filesystem.denyRead.includes(userDirectory));
});

void test('registers no lifecycle commands', (t: TestContext) => {
  const commands: string[] = [];

  sandboxTools({
    on() {
      return undefined;
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool() {
      return undefined;
    },
  } as unknown as Parameters<typeof sandboxTools>[0]);

  t.assert.deepStrictEqual(commands, []);
});
