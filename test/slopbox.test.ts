import {realpathSync} from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {test, type TestContext} from 'node:test';
import {$} from 'execa';
import {
  createConfigStore,
  isDomainAllowed,
  resolveAllowedDirectory,
  shouldPromptOnNetworkDeny,
} from '../agent/extensions/slopbox/config.ts';
import slopbox, {getBlockedDomain} from '../agent/extensions/slopbox/index.ts';
import {
  createSandboxConfig,
  formatSandboxError,
  resolveSandboxReadPath,
  resolveSandboxToolPath,
} from '../agent/extensions/slopbox/sandbox.ts';
import {getFindArguments} from '../agent/extensions/slopbox/tools.ts';

void test('limits filesystem access to the project and session scratch directory', (t: TestContext) => {
  const piAgentPath = join(homedir(), '.pi', 'agent');
  const config = createSandboxConfig('/Users/spencer/Projects/app', '/private/tmp/sloppi-123/tmp');

  t.assert.deepStrictEqual(config.network, {allowedDomains: [], deniedDomains: []});
  t.assert.deepStrictEqual(config.filesystem.allowRead, [
    '/Users/spencer/Projects/app',
    resolveSandboxReadPath(join(piAgentPath, 'skills')),
    resolveSandboxReadPath(join(piAgentPath, 'git')),
    resolveSandboxReadPath(join(piAgentPath, 'npm')),
  ]);
  t.assert.deepStrictEqual(config.filesystem.allowWrite, [
    '/Users/spencer/Projects/app',
    '/private/tmp/sloppi-123/tmp',
  ]);
  t.assert.deepStrictEqual(config.filesystem.denyWrite, []);
  const userDirectory = dirname(homedir());
  t.assert.ok(config.filesystem.denyRead.includes(userDirectory));
});

void test('resolves global skill aliases before passing paths to SRT', (t: TestContext) => {
  const skill = join(homedir(), '.pi', 'agent', 'git', 'github.com', 'DietrichGebert', 'ponytail', 'skills', 'ponytail', 'SKILL.md');
  const npmSkill = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'package', 'skills', 'skill', 'SKILL.md');

  t.assert.strictEqual(resolveSandboxToolPath(skill), resolveSandboxReadPath(skill));
  t.assert.strictEqual(resolveSandboxToolPath(npmSkill), resolveSandboxReadPath(npmSkill));
  t.assert.strictEqual(resolveSandboxToolPath('/tmp/ordinary-file'), '/tmp/ordinary-file');
});

void test('loads the former project directory configuration', (t: TestContext) => {
  const config = createSandboxConfig('/project-a', '/scratch', [], {
    '/project-a': ['/shared/a'],
    '/project-b': ['/shared/b'],
  });

  t.assert.ok(config.filesystem.allowRead?.includes('/shared/a'));
  t.assert.ok(config.filesystem.allowWrite.includes('/shared/a'));
  t.assert.ok(!config.filesystem.allowRead?.includes('/shared/b'));
  t.assert.ok(!config.filesystem.allowWrite.includes('/shared/b'));
});

void test('preserves config changes saved by another running session', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'slopbox.json');
  const first = createConfigStore('/project-a', configPath);
  const second = createConfigStore('/project-b', configPath);

  try {
    await writeFile(configPath, `${JSON.stringify({slopbox: {otherSetting: true}})}\n`);
    await Promise.all([first.load(), second.load()]);
    await first.addDomain('global', 'first.example');
    await second.addDomain('global', 'second.example');
    await second.setPrompting('global', false);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      network: {allowedDomains: string[]};
      slopbox: {otherSetting: boolean; promptOnNetworkDeny: boolean};
    };
    t.assert.deepStrictEqual(saved.network.allowedDomains, ['first.example', 'second.example']);
    t.assert.deepStrictEqual(saved.slopbox, {otherSetting: true, promptOnNetworkDeny: false});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('merges global and project SRT configuration without renaming options', (t: TestContext) => {
  const config = createSandboxConfig('/project', '/scratch', [], {
    slopbox: {promptOnNetworkDeny: true},
    network: {allowedDomains: ['global.example'], deniedDomains: ['blocked.example']},
    filesystem: {allowWrite: ['/global']},
    projects: {
      '/project': {
        slopbox: {promptOnNetworkDeny: false},
        network: {allowedDomains: ['project.example']},
        filesystem: {allowRead: ['/project-read'], allowWrite: ['/project-write']},
      },
    },
  });

  t.assert.deepStrictEqual(config.network.allowedDomains, ['global.example', 'project.example']);
  t.assert.deepStrictEqual(config.network.deniedDomains, ['blocked.example']);
  t.assert.ok(config.filesystem.allowRead?.includes('/project-read'));
  t.assert.ok(config.filesystem.allowWrite.includes('/global'));
  t.assert.ok(config.filesystem.allowWrite.includes('/project-write'));
  t.assert.strictEqual('projects' in config, false);
  t.assert.strictEqual('slopbox' in config, false);
});

void test('extracts blocked domains and applies project prompt overrides', (t: TestContext) => {
  const allowed = {
    network: {allowedDomains: ['api.example.com', '*.example.net:8443']},
    projects: {'/project': {network: {allowedDomains: ['project.example:443']}}},
  };
  t.assert.strictEqual(isDomainAllowed(allowed, '/project', 'api.example.com:443'), true);
  t.assert.strictEqual(isDomainAllowed(allowed, '/project', 'service.example.net:8443'), true);
  t.assert.strictEqual(isDomainAllowed(allowed, '/project', 'service.example.net:443'), false);
  t.assert.strictEqual(isDomainAllowed(allowed, '/project', 'project.example:443'), true);

  const violation = 'deny network-outbound api.example.com:443 (host is not on the allow list)';
  t.assert.strictEqual(getBlockedDomain(violation), 'api.example.com:443');
  t.assert.strictEqual(
    getBlockedDomain('curl: (56) CONNECT tunnel failed, response 403', 'curl https://api.example.com/path'),
    'api.example.com:443',
  );
  t.assert.strictEqual(getBlockedDomain('ordinary failure', 'curl https://api.example.com'), undefined);
  t.assert.strictEqual(shouldPromptOnNetworkDeny({slopbox: {promptOnNetworkDeny: false}}, '/project'), false);
  t.assert.strictEqual(shouldPromptOnNetworkDeny({
    slopbox: {promptOnNetworkDeny: false},
    projects: {'/project': {slopbox: {promptOnNetworkDeny: true}}},
  }, '/project'), true);
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
