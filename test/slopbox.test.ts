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
import process from 'node:process';
import {test, type TestContext} from 'node:test';
import {$} from 'execa';
import slopbox, {
  createSandboxConfig,
  formatSandboxError,
  getFindArguments,
  getAllowedDirectories,
  resolveAllowedDirectory,
  resolveSandboxReadPath,
} from '../agent/extensions/slopbox.ts';

void test('limits filesystem access to the project and session scratch directory', (t: TestContext) => {
  const piAgentPath = join(homedir(), '.pi', 'agent');
  const config = createSandboxConfig('/Users/spencer/Projects/app', '/private/tmp/sloppi-123/tmp');

  t.assert.deepStrictEqual(config.network, {allowedDomains: [], deniedDomains: []});
  t.assert.deepStrictEqual(config.filesystem.allowRead, [
    '/Users/spencer/Projects/app',
    resolveSandboxReadPath(join(piAgentPath, 'skills')),
    resolveSandboxReadPath(join(piAgentPath, 'git')),
  ]);
  t.assert.deepStrictEqual(config.filesystem.allowWrite, [
    '/Users/spencer/Projects/app',
    '/private/tmp/sloppi-123/tmp',
  ]);
  t.assert.deepStrictEqual(config.filesystem.denyWrite, []);
  const userDirectory = dirname(homedir());
  t.assert.ok(config.filesystem.denyRead.includes(userDirectory));
});

void test('loads only the current project directories from saved configuration', (t: TestContext) => {
  const config = {
    '/project-a': ['/shared/a'],
    '/project-b': ['/shared/b'],
  };

  t.assert.deepStrictEqual(getAllowedDirectories(config, '/project-a'), ['/shared/a']);
  t.assert.deepStrictEqual(getAllowedDirectories(config, '/missing'), []);
  t.assert.deepStrictEqual(getAllowedDirectories({'/project-a': [123]}, '/project-a'), []);
});

void test('resolves directories before adding them to the sandbox policy', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const target = join(directory, 'target');
  const link = join(directory, 'link');

  try {
    await mkdir(target);
    await symlink(target, link);
    const physicalTarget = realpathSync(target);
    t.assert.strictEqual(resolveSandboxReadPath(link), physicalTarget);
    t.assert.strictEqual(resolveAllowedDirectory(directory, 'target'), physicalTarget);

    const config = createSandboxConfig('/project', '/scratch', [physicalTarget]);
    t.assert.ok(config.filesystem.allowRead?.includes(physicalTarget));
    t.assert.ok(config.filesystem.allowWrite?.includes(physicalTarget));
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('SRT denies writes outside the project and session scratch directory', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const projectPath = realpathSync(process.cwd());
  const scratchPath = join(directory, 'scratch');
  const outsidePath = join(directory, 'outside');
  const settingsPath = join(directory, 'settings.json');

  try {
    await Promise.all([mkdir(scratchPath), mkdir(outsidePath)]);
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

void test('registers /slopbox to allow directories during a session', (t: TestContext) => {
  const commands: string[] = [];

  slopbox({
    on() {
      return undefined;
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool() {
      return undefined;
    },
  } as unknown as Parameters<typeof slopbox>[0]);

  t.assert.deepStrictEqual(commands, ['slopbox']);
});

void test('uses native find arguments on macOS', (t: TestContext) => {
  t.assert.deepStrictEqual(
    getFindArguments({
      platform: 'darwin',
      pattern: '*.test.ts',
      path: 'test',
      ignore: ['**/node_modules/**', '**/.git/**'],
      limit: 100,
    }),
    [
      'find',
      'test',
      '-type',
      'f',
      '!',
      '-path',
      '***/node_modules/**',
      '!',
      '-path',
      '***/.git/**',
      '-name',
      '*.test.ts',
      '-print',
    ],
  );
});
