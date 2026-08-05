import {realpathSync} from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test, type TestContext} from 'node:test';
import {$} from 'execa';
import sandboxTools, {
  createSandboxConfig,
  formatSandboxError,
  resolveSandboxReadPath,
} from '../agent/extensions/sandbox-tools.ts';

void test('limits filesystem access to the project and session scratch directory', (t: TestContext) => {
  const config = createSandboxConfig('/Users/spencer/Projects/app', '/private/tmp/sloppi-123/tmp');

  t.assert.deepStrictEqual(config.network, {allowedDomains: [], deniedDomains: []});
  t.assert.deepStrictEqual(config.filesystem.allowRead, [
    '/Users/spencer/Projects/app',
    join(homedir(), '.pi', 'agent', 'skills'),
    join(homedir(), '.pi', 'agent', 'git'),
  ]);
  t.assert.deepStrictEqual(config.filesystem.allowWrite, [
    '/Users/spencer/Projects/app',
    '/private/tmp/sloppi-123/tmp',
  ]);
  t.assert.deepStrictEqual(config.filesystem.denyWrite, []);
  const userDirectory = dirname(homedir());
  t.assert.ok(config.filesystem.denyRead.includes(userDirectory));
});

void test('resolves a symlinked skill directory before adding it to the sandbox policy', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const target = join(directory, 'target');
  const link = join(directory, 'link');

  try {
    await mkdir(target);
    await symlink(target, link);
    const physicalTarget = realpathSync(target);
    t.assert.strictEqual(resolveSandboxReadPath(link), physicalTarget);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('SRT denies writes outside the project and session scratch directory', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const projectPath = join(directory, 'project');
  const scratchPath = join(directory, 'scratch');
  const outsidePath = join(directory, 'outside');
  const settingsPath = join(directory, 'settings.json');

  try {
    await Promise.all([mkdir(projectPath), mkdir(scratchPath), mkdir(outsidePath)]);
    await writeFile(settingsPath, `${JSON.stringify(createSandboxConfig(projectPath, scratchPath))}\n`);

    const srtPath = resolve(import.meta.dirname, '../node_modules/.bin/srt');
    const result = await $({reject: false})`${srtPath} --settings ${settingsPath} -- sh -c ${'echo blocked > "$1"'} sh ${join(outsidePath, 'blocked.txt')}`;

    t.assert.notStrictEqual(result.exitCode, 0);
    t.assert.match(formatSandboxError(result.stderr.trim(), 'write failed'), /sandbox restriction/iv);
    await t.assert.rejects(access(join(outsidePath, 'blocked.txt')), {code: 'ENOENT'});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('leaves ordinary command errors unchanged', (t: TestContext) => {
  t.assert.strictEqual(formatSandboxError('command failed', 'fallback'), 'command failed');
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
