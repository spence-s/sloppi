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
import {SandboxRuntimeConfigSchema} from '@anthropic-ai/sandbox-runtime';
import {ConfigStore} from '../agent/extensions/sloppi/config.ts';
import slopbox, {getBlockedDomain} from '../agent/extensions/sloppi/index.ts';
import {
  resolveSandboxReadPath,
  resolveSandboxToolPath,
  Sandbox,
} from '../agent/extensions/sloppi/sandbox.ts';
import {SandboxTools} from '../agent/extensions/sloppi/tools.ts';

void test('limits filesystem access to the project and session scratch directory', async (t: TestContext) => {
  const piAgentPath = join(homedir(), '.pi', 'agent');
  const sandbox = new Sandbox(
    '/Users/spencer/Projects/app',
    new ConfigStore('/Users/spencer/Projects/app'),
  );

  try {
    const session = await sandbox.startSession();
    const settings = await readFile(session.settingsPath, 'utf8');
    const config = SandboxRuntimeConfigSchema.parse(JSON.parse(settings));
    t.assert.deepStrictEqual(config.network, {allowedDomains: [], deniedDomains: []});
    t.assert.deepStrictEqual(config.filesystem.allowRead, [
      '/Users/spencer/Projects/app',
      resolveSandboxReadPath(join(piAgentPath, 'skills')),
      resolveSandboxReadPath(join(piAgentPath, 'git')),
      resolveSandboxReadPath(join(piAgentPath, 'npm')),
    ]);
    t.assert.deepStrictEqual(config.filesystem.allowWrite, [
      '/Users/spencer/Projects/app',
      session.scratchPath,
    ]);
    t.assert.deepStrictEqual(config.filesystem.denyWrite, []);
    const userDirectory = dirname(homedir());
    t.assert.ok(config.filesystem.denyRead.includes(userDirectory));
  } finally {
    await sandbox.stopSession();
  }
});

void test('requires an explicit session before running commands', async (t: TestContext) => {
  const sandbox = new Sandbox('/project', new ConfigStore('/project'));
  await t.assert.rejects(sandbox.run(['true']), /has not started/v);
});

void test('resolves global skill aliases before passing paths to SRT', (t: TestContext) => {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  const gitDirectory = join(agentDirectory, 'git');
  const npmDirectory = join(agentDirectory, 'npm');
  const gitSuffix = join('github.com', 'DietrichGebert', 'ponytail', 'skills', 'ponytail', 'SKILL.md');
  const npmSuffix = join('node_modules', 'package', 'skills', 'skill', 'SKILL.md');

  t.assert.strictEqual(
    resolveSandboxToolPath(join(gitDirectory, gitSuffix)),
    join(resolveSandboxReadPath(gitDirectory), gitSuffix),
  );
  t.assert.strictEqual(
    resolveSandboxToolPath(join(npmDirectory, npmSuffix)),
    join(resolveSandboxReadPath(npmDirectory), npmSuffix),
  );
  t.assert.strictEqual(resolveSandboxToolPath('/tmp/ordinary-file'), '/tmp/ordinary-file');
});

void test('loads the former project directory configuration', async (t: TestContext) => {
  const configStore = new ConfigStore('/project-a');
  configStore.config = {
    '/project-a': ['/shared/a'],
    '/project-b': ['/shared/b'],
  };
  configStore.hasLoaded = true;
  const sandbox = new Sandbox('/project-a', configStore);

  try {
    const session = await sandbox.startSession();
    const settings = await readFile(session.settingsPath, 'utf8');
    const config = SandboxRuntimeConfigSchema.parse(JSON.parse(settings));
    t.assert.ok(config.filesystem.allowRead?.includes('/shared/a'));
    t.assert.ok(config.filesystem.allowWrite.includes('/shared/a'));
    t.assert.ok(!config.filesystem.allowRead?.includes('/shared/b'));
    t.assert.ok(!config.filesystem.allowWrite.includes('/shared/b'));
  } finally {
    await sandbox.stopSession();
  }
});

void test('preserves config changes saved by another running session', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'slopbox.json');
  const first = new ConfigStore('/project-a', configPath);
  const second = new ConfigStore('/project-b', configPath);

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

void test('merges global and project SRT configuration without renaming options', async (t: TestContext) => {
  const configStore = new ConfigStore('/project');
  configStore.config = {
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
  };
  configStore.hasLoaded = true;
  const sandbox = new Sandbox('/project', configStore);

  try {
    const session = await sandbox.startSession();
    const settings = await readFile(session.settingsPath, 'utf8');
    const config = SandboxRuntimeConfigSchema.parse(JSON.parse(settings));
    t.assert.deepStrictEqual(config.network.allowedDomains, ['global.example', 'project.example']);
    t.assert.deepStrictEqual(config.network.deniedDomains, ['blocked.example']);
    t.assert.ok(config.filesystem.allowRead?.includes('/project-read'));
    t.assert.ok(config.filesystem.allowWrite.includes('/global'));
    t.assert.ok(config.filesystem.allowWrite.includes('/project-write'));
    t.assert.strictEqual('projects' in config, false);
    t.assert.strictEqual('slopbox' in config, false);
  } finally {
    await sandbox.stopSession();
  }
});

void test('extracts blocked domains and applies project prompt overrides', (t: TestContext) => {
  const allowed = {
    network: {allowedDomains: ['api.example.com', '*.example.net:8443']},
    projects: {'/project': {network: {allowedDomains: ['project.example:443']}}},
  };
  const configStore = new ConfigStore('/project');
  configStore.config = allowed;
  t.assert.strictEqual(configStore.isDomainAllowed('api.example.com:443'), true);
  t.assert.strictEqual(configStore.isDomainAllowed('service.example.net:8443'), true);
  t.assert.strictEqual(configStore.isDomainAllowed('service.example.net:443'), false);
  t.assert.strictEqual(configStore.isDomainAllowed('project.example:443'), true);

  const violation = 'deny network-outbound api.example.com:443 (host is not on the allow list)';
  t.assert.strictEqual(getBlockedDomain(violation), 'api.example.com:443');
  t.assert.strictEqual(
    getBlockedDomain('curl: (56) CONNECT tunnel failed, response 403', 'curl https://api.example.com/path'),
    'api.example.com:443',
  );
  t.assert.strictEqual(getBlockedDomain('ordinary failure', 'curl https://api.example.com'), undefined);
  configStore.config = {slopbox: {promptOnNetworkDeny: false}};
  t.assert.strictEqual(configStore.shouldPrompt(), false);
  configStore.config = {
    slopbox: {promptOnNetworkDeny: false},
    projects: {'/project': {slopbox: {promptOnNetworkDeny: true}}},
  };
  t.assert.strictEqual(configStore.shouldPrompt(), true);
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
    t.assert.strictEqual(new ConfigStore(directory).resolveAllowedDirectory('target'), physicalTarget);

    const configStore = new ConfigStore('/project');
    configStore.config = {filesystem: {allowRead: [physicalTarget], allowWrite: [physicalTarget]}};
    configStore.hasLoaded = true;
    const sandbox = new Sandbox('/project', configStore);
    try {
      const session = await sandbox.startSession();
      const settings = await readFile(session.settingsPath, 'utf8');
      const config = SandboxRuntimeConfigSchema.parse(JSON.parse(settings));
      t.assert.ok(config.filesystem.allowRead?.includes(physicalTarget));
      t.assert.ok(config.filesystem.allowWrite.includes(physicalTarget));
    } finally {
      await sandbox.stopSession();
    }
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('SRT denies writes outside the project and session scratch directory', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const projectPath = realpathSync(process.cwd());
  const outsidePath = join(directory, 'outside');
  const sandbox = new Sandbox(projectPath, new ConfigStore(projectPath));

  try {
    await mkdir(outsidePath);
    await sandbox.startSession();
    await t.assert.rejects(
      sandbox.run(['sh', '-c', 'echo blocked > "$1"', 'sh', join(outsidePath, 'blocked.txt')]),
      /sandbox restriction/iv,
    );
    await t.assert.rejects(access(join(outsidePath, 'blocked.txt')), {code: 'ENOENT'});
  } finally {
    await sandbox.stopSession();
    await rm(directory, {force: true, recursive: true});
  }
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
    SandboxTools.getFindArguments({
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
