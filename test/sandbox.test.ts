import {realpathSync} from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {test, type TestContext} from 'node:test';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {execa} from 'execa';
import {
  initTheme,
  Theme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {discoverResearchAgents} from '../agent/extensions/sandbox/agents.ts';
import {SandboxCommand} from '../agent/extensions/sandbox/command.ts';
import {ConfigStore} from '../agent/extensions/sandbox/config.ts';
import sandboxExtension, {Sandbox as SandboxExtension} from '../agent/extensions/sandbox/index.ts';
import {SandboxSessionManager} from '../agent/extensions/sandbox/session-manager.ts';
import {SandboxSubagent} from '../agent/extensions/sandbox/subagent.ts';
import {SandboxTools} from '../agent/extensions/sandbox/tools.ts';

void test('uses no persisted sandbox access by default', (t: TestContext) => {
  const configStore = new ConfigStore('/Users/spencer/Projects/app');
  configStore.hasLoaded = true;

  t.assert.deepStrictEqual(configStore.getEffectiveConfig(), {});
});

void test('loads user research agents without expanding the read-only tool set', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-agent-test-'));

  try {
    await writeFile(join(directory, 'custom.md'), `---
name: custom
description: Custom repository analysis
tools: read, grep, bash
model: test/small
---

Follow the custom instructions.
`);
    await writeFile(join(directory, 'invalid.md'), 'Missing required frontmatter.\n');

    const agents = discoverResearchAgents(directory);
    const custom = agents.find(agent => agent.name === 'custom');
    t.assert.deepStrictEqual(custom, {
      name: 'custom',
      description: 'Custom repository analysis',
      tools: ['read', 'grep'],
      model: 'test/small',
      systemPrompt: 'Follow the custom instructions.',
    });
    t.assert.deepStrictEqual(agents.map(agent => agent.name), ['scout', 'planner', 'reviewer', 'custom']);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('keeps research agents disabled until globally enabled', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-agent-toggle-test-'));
  const path = join(directory, 'sandbox.json');
  const config = new ConfigStore('/project', path);

  try {
    await config.load();
    t.assert.strictEqual(config.areResearchAgentsEnabled(), false);
    await config.setResearchAgentsEnabled(true);
    await config.reload();
    t.assert.strictEqual(config.areResearchAgentsEnabled(), true);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('persists the globally selected Research Scout model', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-scout-model-test-'));
  const path = join(directory, 'sandbox.json');
  const config = new ConfigStore('/project', path);

  try {
    await config.setResearchScoutModel({provider: 'test', id: 'small'});
    await config.reload();
    t.assert.deepStrictEqual(config.getResearchScoutModel(), {provider: 'test', id: 'small'});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('requires an explicit session before running commands', async (t: TestContext) => {
  const sandbox = new SandboxSessionManager('/project', new ConfigStore('/project'));
  await t.assert.rejects(sandbox.run`true`, /has not started/v);
});

/**
 Verifies failed startup removes its private scratch directory.
 */
void test('cleans up after sandbox configuration errors', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-startup-error-test-'));
  const config = new ConfigStore('/project');
  config.config = {network: {allowedDomains: ['*']}};
  config.hasLoaded = true;
  const sandbox = new SandboxSessionManager('/project', config);
  t.mock.property(process, 'env', {...process.env, TMPDIR: directory});

  try {
    await t.assert.rejects(sandbox.startSession(), /Invalid domain pattern/v);
    t.assert.deepStrictEqual(await readdir(directory), []);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('isolates reads and temporary Unix sockets', async (t: TestContext) => {
  const directory = realpathSync(process.cwd());
  const configStore = new ConfigStore(directory);
  configStore.hasLoaded = true;
  const sandbox = new SandboxSessionManager(directory, configStore);
  const homeDirectory = dirname(homedir());
  const previousClaudeCodeTmpdir = process.env.CLAUDE_CODE_TMPDIR;
  const previousTmpdir = process.env.TMPDIR;
  try {
    await sandbox.startSession();
    const scratchPath = sandbox.session?.scratchPath;
    if (scratchPath === undefined) {
      throw new Error('Sandbox scratch directory was not created.');
    }

    const deniedReadPaths = SandboxManager.getConfig()?.filesystem?.denyRead ?? [];
    t.assert.ok(deniedReadPaths.some(path => [homeDirectory, homedir()].includes(path)));
    t.assert.ok(SandboxManager.getConfig()?.network?.allowUnixSockets?.includes(scratchPath));
    t.assert.strictEqual(process.env.CLAUDE_CODE_TMPDIR, scratchPath);
    t.assert.strictEqual(process.env.TMPDIR, scratchPath);

    const wrapped = await SandboxManager.wrapWithSandbox('true');
    t.assert.match(wrapped, new RegExp(`TMPDIR=${scratchPath}`, 'v'));
    let nodeProxy = '1';
    if (process.env.USER !== 'sandbox') {
      const result = await sandbox.run`printf %s "$NODE_USE_ENV_PROXY"`;
      nodeProxy = result.stdout;
    }

    t.assert.strictEqual(nodeProxy, '1');
  } finally {
    await sandbox.stopSession();
  }

  t.assert.strictEqual(process.env.CLAUDE_CODE_TMPDIR, previousClaudeCodeTmpdir);
  t.assert.strictEqual(process.env.TMPDIR, previousTmpdir);
});

/**
 Verifies that opting into host configuration changes lookup behavior without changing filesystem policy.
 */
void test('uses the host home when HOME is explicitly exposed', async (t: TestContext) => {
  if (process.env.USER === 'sandbox') {
    t.skip('Sandbox Runtime cannot apply a second macOS sandbox profile.');
    return;
  }

  const directory = realpathSync(process.cwd());
  const configStore = new ConfigStore(directory);
  configStore.config = {sandbox: {exposeEnv: ['HOME']}};
  configStore.hasLoaded = true;
  const sandbox = new SandboxSessionManager(directory, configStore);
  t.mock.property(process, 'env', {...process.env, HOME: directory});

  try {
    await sandbox.startSession();
    const result = await sandbox.run`printf %s "$HOME"`;
    t.assert.strictEqual(result.stdout, directory);
  } finally {
    await sandbox.stopSession();
  }
});

void test('allows only logical and canonical global skill directories', async (t: TestContext) => {
  const directory = await mkdtemp(join(process.cwd(), '.sloppi-skills-test-'));
  const logicalPiAgentPath = join(directory, '.pi-agent');
  const actualPiAgentPath = join(directory, 'actual-pi-agent');
  const logicalAgentsSkillPath = join(homedir(), '.agents', 'skills');
  const sandbox = new SandboxSessionManager(directory, new ConfigStore(directory, join(directory, 'sandbox.json')));

  try {
    await Promise.all(['skills', 'git', 'npm'].map(async path => mkdir(join(actualPiAgentPath, path), {recursive: true})));
    await symlink(actualPiAgentPath, logicalPiAgentPath);
    t.mock.property(process, 'env', {...process.env, PI_CODING_AGENT_DIR: logicalPiAgentPath});

    await sandbox.startSession();
    const skillDirectories = ['skills', 'git', 'npm'];
    const allowRead = SandboxManager.getConfig()?.filesystem?.allowRead ?? [];
    let realAgentsSkillPath = logicalAgentsSkillPath;
    try {
      realAgentsSkillPath = realpathSync(logicalAgentsSkillPath);
    } catch {}

    const expectedAllowRead = [
      directory,
      ...skillDirectories.map(path => join(logicalPiAgentPath, path)),
      ...skillDirectories.map(path => join(realpathSync(actualPiAgentPath), path)),
      ...new Set([logicalAgentsSkillPath, realAgentsSkillPath]),
    ];
    t.assert.deepStrictEqual(allowRead, expectedAllowRead);
  } finally {
    await sandbox.stopSession();
    await rm(directory, {force: true, recursive: true});
  }
});

void test('loads the former project directory configuration', (t: TestContext) => {
  const configStore = new ConfigStore('/project-a');
  configStore.config = {
    '/project-a': ['/shared/a'],
    '/project-b': ['/shared/b'],
  };
  configStore.hasLoaded = true;
  const config = configStore.getEffectiveConfig();

  t.assert.ok(config.filesystem?.allowRead?.includes('/shared/a'));
  t.assert.ok(config.filesystem?.allowWrite?.includes('/shared/a'));
  t.assert.ok(!config.filesystem?.allowRead?.includes('/shared/b'));
  t.assert.ok(!config.filesystem?.allowWrite?.includes('/shared/b'));
});

void test('preserves config changes saved by another running session', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'sandbox.json');
  const first = new ConfigStore('/project-a', configPath);
  const second = new ConfigStore('/project-b', configPath);

  try {
    await writeFile(configPath, `${JSON.stringify({sandbox: {otherSetting: true}})}\n`);
    await Promise.all([first.load(), second.load()]);
    await first.updateDomain('global', 'allow', 'add', 'first.example');
    await second.updateDomain('global', 'allow', 'add', 'second.example');
    await second.setPrompting('global', false);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      network: {allowedDomains: string[]};
      sandbox: {otherSetting: boolean; promptOnNetworkDeny: boolean};
    };
    t.assert.deepStrictEqual(saved.network.allowedDomains, ['first.example', 'second.example']);
    t.assert.deepStrictEqual(saved.sandbox, {otherSetting: true, promptOnNetworkDeny: false});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('adds and removes scoped filesystem and network rules', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);

  try {
    await configStore.updateFilesystem('global', ['allowRead', 'allowWrite'], 'add', '/shared');
    await configStore.updateFilesystem('project', 'denyWrite', 'add', '/shared/protected');
    await configStore.updateDomain('global', 'allow', 'add', 'api.example.com:443');
    await configStore.updateDomain('project', 'deny', 'add', 'blocked.example.com', 'Use the approved API.');

    let saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      filesystem: {allowRead: string[]; allowWrite: string[]};
      network: {allowedDomains: string[]};
      projects: Record<string, {
        filesystem: {denyWrite: string[]};
        network: {deniedDomains: string[]; deniedDomainReasons: Record<string, string>};
      }>;
    };
    t.assert.deepStrictEqual(saved.filesystem.allowRead, ['/shared']);
    t.assert.deepStrictEqual(saved.filesystem.allowWrite, ['/shared']);
    t.assert.deepStrictEqual(saved.network.allowedDomains, ['api.example.com:443']);
    t.assert.deepStrictEqual(saved.projects['/project']?.filesystem.denyWrite, ['/shared/protected']);
    t.assert.strictEqual(saved.projects['/project']?.network.deniedDomainReasons['blocked.example.com'], 'Use the approved API.');

    await configStore.updateFilesystem('global', ['allowRead', 'allowWrite'], 'remove', '/shared');
    await configStore.updateDomain('project', 'deny', 'remove', 'blocked.example.com');
    saved = JSON.parse(await readFile(configPath, 'utf8')) as typeof saved;
    t.assert.deepStrictEqual(saved.filesystem.allowRead, []);
    t.assert.deepStrictEqual(saved.filesystem.allowWrite, []);
    t.assert.deepStrictEqual(saved.projects['/project']?.network.deniedDomains, []);
    t.assert.deepStrictEqual(saved.projects['/project']?.network.deniedDomainReasons, {});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('validates advanced SRT edits and resets one scope', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);

  try {
    await configStore.replaceSrtConfig('project', {
      network: {allowedDomains: [], deniedDomains: ['blocked.example.com']},
    });
    await t.assert.rejects(
      configStore.replaceSrtConfig('project', {network: {allowedDomains: ['*'], deniedDomains: []}}),
      /Invalid SRT configuration/v,
    );
    t.assert.deepStrictEqual(configStore.getEffectiveConfig().network?.deniedDomains, ['blocked.example.com']);

    await configStore.resetScope('project');
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {projects?: Record<string, unknown>};
    t.assert.strictEqual(saved.projects?.['/project'], undefined);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('merges global and project SRT configuration without renaming options', (t: TestContext) => {
  const configStore = new ConfigStore('/project');
  configStore.config = {
    sandbox: {promptOnNetworkDeny: true},
    network: {allowedDomains: ['global.example'], deniedDomains: ['blocked.example']},
    filesystem: {allowWrite: ['/global']},
    projects: {
      '/project': {
        sandbox: {promptOnNetworkDeny: false},
        network: {allowedDomains: ['project.example']},
        filesystem: {allowRead: ['/project-read'], allowWrite: ['/project-write']},
      },
    },
  };
  configStore.hasLoaded = true;
  const config = configStore.getEffectiveConfig();

  t.assert.deepStrictEqual(config.network?.allowedDomains, ['global.example', 'project.example']);
  t.assert.deepStrictEqual(config.network?.deniedDomains, ['blocked.example']);
  t.assert.ok(config.filesystem?.allowRead?.includes('/project-read'));
  t.assert.ok(config.filesystem?.allowWrite?.includes('/global'));
  t.assert.ok(config.filesystem?.allowWrite?.includes('/project-write'));
  t.assert.strictEqual('projects' in config, false);
  t.assert.strictEqual('sandbox' in config, false);
});

void test('applies network configuration and project prompt overrides', (t: TestContext) => {
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

  configStore.config = {sandbox: {promptOnNetworkDeny: false}};
  t.assert.strictEqual(configStore.shouldPrompt(), false);
  configStore.config = {
    sandbox: {promptOnNetworkDeny: false},
    projects: {'/project': {sandbox: {promptOnNetworkDeny: true}}},
  };
  t.assert.strictEqual(configStore.shouldPrompt(), true);
});

void test('combines and validates configured host environment variable names', (t: TestContext) => {
  const configStore = new ConfigStore('/project');
  configStore.config = {
    sandbox: {exposeEnv: ['SAFE_GLOBAL', 'SHARED']},
    projects: {'/project': {sandbox: {exposeEnv: ['SAFE_PROJECT', 'SHARED']}}},
  };
  t.assert.deepStrictEqual(configStore.getExposedEnv(), ['SAFE_GLOBAL', 'SHARED', 'SAFE_PROJECT']);

  configStore.config = {sandbox: {exposeEnv: ['NOT-VALID']}};
  t.assert.throws(() => configStore.getExposedEnv(), /Invalid sandbox\.exposeEnv/v);
});

void test('filters configured destinations by method, path, and header', async (t: TestContext) => {
  const directory = realpathSync(process.cwd());
  const configStore = new ConfigStore(directory);
  configStore.config = {
    sandbox: {
      requestPolicies: [{
        destination: 'api.example.com:443',
        allow: [{
          methods: ['post'],
          pathPrefixes: ['/v1/jobs'],
          headers: {'X-Environment': ['preview']},
        }],
      }],
    },
  };
  configStore.hasLoaded = true;
  const sandbox = new SandboxSessionManager(directory, configStore);

  try {
    await sandbox.startSession();
    const filterRequest = SandboxManager.getConfig()?.network.filterRequest;
    if (filterRequest === undefined) {
      throw new Error('Request filter was not configured.');
    }

    const headers = {'x-environment': 'preview'};
    t.assert.deepStrictEqual(
      await filterRequest(new Request('https://api.example.com/v1/jobs/123', {method: 'POST', headers})),
      {action: 'allow'},
    );
    t.assert.deepStrictEqual(
      await filterRequest(new Request('https://api.example.com./v1/jobs', {method: 'POST', headers})),
      {action: 'allow'},
    );
    const wrongPath = await filterRequest(new Request('https://api.example.com/v1/jobshop', {method: 'POST', headers}));
    t.assert.strictEqual(wrongPath.action, 'deny');
    const wrongMethod = await filterRequest(new Request('https://api.example.com/v1/jobs', {headers}));
    t.assert.strictEqual(wrongMethod.action, 'deny');
    const missingHeader = await filterRequest(new Request('https://api.example.com/v1/jobs', {method: 'POST'}));
    t.assert.strictEqual(missingHeader.action, 'deny');
    const wrongHeader = await filterRequest(new Request('https://api.example.com/v1/jobs', {
      method: 'POST',
      headers: {'x-environment': 'production'},
    }));
    t.assert.strictEqual(wrongHeader.action, 'deny');
    t.assert.deepStrictEqual(
      await filterRequest(new Request('https://other.example.com/anything')),
      {action: 'allow'},
    );
  } finally {
    await sandbox.stopSession();
  }

  configStore.config = {
    network: {
      allowedDomains: ['api.example.com:443'],
      tlsTerminate: {excludeDomains: ['*.example.com']},
    },
    sandbox: {
      requestPolicies: [{destination: 'api.example.com:443', allow: [{paths: ['/v1/jobs']}]}],
    },
  };
  await t.assert.rejects(sandbox.startSession(), /cannot be excluded from TLS termination/v);

  configStore.config = {
    sandbox: {
      requestPolicies: [{destination: 'api.example.com:443', allow: [{paths: ['relative']}]}],
    },
  };
  t.assert.throws(() => configStore.getRequestPolicies(), /paths must start with \//v);

  configStore.config = {
    sandbox: {
      requestPolicies: [{destination: '*.example.com:443', allow: [{paths: ['/v1/jobs']}]}],
    },
  };
  t.assert.throws(() => configStore.getRequestPolicies(), /exact host:port/v);
});

void test('SRT denies writes outside the project and session scratch directory', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-sandbox-test-'));
  const projectPath = realpathSync(process.cwd());
  const outsidePath = join(directory, 'outside');
  try {
    await mkdir(outsidePath);
    const outputPath = join(outsidePath, 'blocked.txt');
    const command = `sh -c 'echo blocked > "$1"' sh '${outputPath}'`;
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const result = await execa(wrapped, {cwd: projectPath, reject: false, shell: true});
    t.assert.notStrictEqual(result.exitCode, 0);
    await t.assert.rejects(access(outputPath), {code: 'ENOENT'});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('writes a new file through the sandbox tool and creates missing parents', async (t: TestContext) => {
  if (process.env.USER === 'sandbox') {
    t.skip('Sandbox Runtime cannot apply a second macOS sandbox profile.');
    return;
  }

  type WriteTool = {execute: (...arguments_: unknown[]) => Promise<unknown>};

  const directory = await mkdtemp(join(process.cwd(), '.sloppi-write-test-'));
  const config = new ConfigStore(directory, join(directory, 'sandbox.json'));
  const sandbox = new SandboxSessionManager(directory, config);
  let writeTool: WriteTool | undefined;
  const pi = {
    registerTool(tool: unknown) {
      if ((tool as {name?: string}).name === 'write') {
        writeTool = tool as WriteTool;
      }
    },
  } as unknown as ExtensionAPI;

  try {
    await sandbox.startSession();
    new SandboxTools(pi, directory, sandbox).register();
    if (writeTool === undefined) {
      throw new Error('write tool was not registered');
    }

    const outputPath = join(directory, 'missing', 'probe.txt');
    await writeTool.execute('write-test', {path: outputPath, content: 'sandbox write probe\n'}, undefined, undefined, undefined);
    t.assert.strictEqual(await readFile(outputPath, 'utf8'), 'sandbox write probe\n');
  } finally {
    await sandbox.stopSession();
    await rm(directory, {force: true, recursive: true});
  }
});

void test('adds current sandbox access to the system prompt', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-prompt-test-'));
  const configPath = join(directory, 'sandbox.json');
  const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  let activeTools = ['read', 'research_scout'];
  const pi = {
    getActiveTools() {
      return activeTools;
    },
    on(name: string, handler: (...arguments_: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {
      return undefined;
    },
    registerTool() {
      return undefined;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI;

  try {
    await writeFile(configPath, JSON.stringify({
      filesystem: {allowWrite: ['/shared']},
      network: {allowedDomains: ['api.example.com']},
    }));
    const extension = new SandboxExtension(pi);
    extension.config = new ConfigStore(extension.cwd, configPath);
    extension.register();

    const handler = handlers.get('before_agent_start');
    if (handler === undefined) {
      throw new Error('before_agent_start handler was not registered');
    }

    const result = await handler({systemPrompt: 'base'}) as {systemPrompt: string};
    t.assert.deepStrictEqual(activeTools, ['read']);
    t.assert.match(result.systemPrompt, new RegExp(JSON.stringify(extension.cwd), 'v'));
    t.assert.match(result.systemPrompt, /"\/shared"/v);
    t.assert.match(result.systemPrompt, /"api\.example\.com"/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('reports approved network access to both the UI and the model', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-approval-test-'));
  const configPath = join(directory, 'sandbox.json');
  const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  const notifications: string[] = [];
  const selections = ['Deny', 'Allow blocked.example:443 for this project'];
  let restarts = 0;
  const pi = {
    on(name: string, handler: (...arguments_: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {
      return undefined;
    },
    registerTool() {
      return undefined;
    },
  } as unknown as ExtensionAPI;
  const extension = new SandboxExtension(pi);
  extension.config = new ConfigStore(extension.cwd, configPath);
  extension.sandbox = {
    async restartSession() {
      restarts += 1;
    },
  } as unknown as SandboxSessionManager;
  extension.register();

  const handler = handlers.get('tool_result');
  const event = {
    toolName: 'bash',
    input: {command: 'curl https://blocked.example/resource'},
    content: [{type: 'text', text: 'connection blocked by network allowlist'}],
  };
  const ctx = {
    hasUI: true,
    ui: {
      input: async () => undefined,
      notify(message: string) {
        notifications.push(message);
      },
      select: async () => selections.shift(),
    },
  };

  try {
    if (handler === undefined) {
      throw new Error('tool_result handler was not registered');
    }

    t.assert.strictEqual(await handler(event, ctx), undefined);
    const result = await handler(event, ctx) as {content: Array<{type: string; text: string}>};
    const approvalMessage = 'Sandbox access to blocked.example:443 was approved and is now active. Retry the failed tool call.';

    t.assert.strictEqual(restarts, 1);
    t.assert.strictEqual(notifications.at(-1), approvalMessage);
    t.assert.deepStrictEqual(result.content, [...event.content, {type: 'text', text: approvalMessage}]);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('/sandbox mutates projects by default and global configuration only when requested', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-command-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);
  const selections = ['Filesystem', 'Add rule', 'Allow read', 'Filesystem', 'Add rule', 'Allow write'];
  const inputs = ['/project-read', '/global-write'];
  const notifications: string[] = [];
  let handler: Handler | undefined;
  let restarts = 0;

  new SandboxCommand(configStore, {
    async restartSession() {
      restarts += 1;
    },
  } as unknown as SandboxSessionManager).register({
    registerCommand(_name: string, options: {handler: Handler}) {
      handler = options.handler;
    },
  } as unknown as ExtensionAPI);

  const ctx = {
    ui: {
      input: async () => inputs.shift(),
      notify(message: string) {
        notifications.push(message);
      },
      select: async () => selections.shift(),
    },
  } as unknown as ExtensionCommandContext;

  try {
    if (handler === undefined) {
      throw new Error('/sandbox handler was not registered');
    }

    await handler('', ctx);
    await handler('global', ctx);
    await handler('show', ctx);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      filesystem: {allowWrite: string[]};
      projects: Record<string, {filesystem: {allowRead: string[]}}>;
    };
    t.assert.deepStrictEqual(saved.projects['/project']?.filesystem.allowRead, ['/project-read']);
    t.assert.deepStrictEqual(saved.filesystem.allowWrite, ['/global-write']);
    t.assert.strictEqual(restarts, 2);
    t.assert.match(notifications.at(-1) ?? '', /Use \/sandbox or \/sandbox global/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('/sandbox does not remove inherited global rules from project scope', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-command-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);
  await writeFile(configPath, `${JSON.stringify({filesystem: {allowRead: ['/global-read']}})}\n`);
  const notifications: string[] = [];
  let handler: Handler | undefined;

  new SandboxCommand(configStore, {
    async restartSession() {
      throw new Error('Inherited rules must not restart the sandbox.');
    },
  } as unknown as SandboxSessionManager).register({
    registerCommand(_name: string, options: {handler: Handler}) {
      handler = options.handler;
    },
  } as unknown as ExtensionAPI);

  const selections = ['Filesystem', 'Remove rule', 'Allow read'];
  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      select: async (title: string, options: string[]) => title === 'Remove effective filesystem rule'
        ? options.find(option => option.includes('/global-read'))
        : selections.shift(),
    },
  } as unknown as ExtensionCommandContext;

  try {
    if (handler === undefined) {
      throw new Error('/sandbox handler was not registered');
    }

    await handler('', ctx);
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {filesystem: {allowRead: string[]}};
    t.assert.deepStrictEqual(saved.filesystem.allowRead, ['/global-read']);
    t.assert.match(notifications.at(-1) ?? '', /Use \/sandbox global/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies that delegation exposes only the narrow read-only scout entrypoint.
 */
void test('registers the read-only research scout', (t: TestContext) => {
  const tools: Array<{name: string; label: string}> = [];
  const subagent = new SandboxSubagent({
    registerTool(tool: {name: string; label: string}) {
      tools.push({name: tool.name, label: tool.label});
    },
  } as unknown as ExtensionAPI, '/project', {} as SandboxSessionManager, new ConfigStore('/project'));

  subagent.register();

  t.assert.deepStrictEqual(tools, [{name: 'research_scout', label: 'Research Scout'}]);
});

void test('renders a stable live research dashboard and legacy results', (t: TestContext) => {
  let registered: ToolDefinition | undefined;
  const subagent = new SandboxSubagent({
    registerTool(tool: ToolDefinition) {
      registered = tool;
    },
  } as unknown as ExtensionAPI, '/project', {} as SandboxSessionManager, new ConfigStore('/project'));

  subagent.register();
  initTheme(undefined, false);
  const {renderResult} = registered ?? {};
  if (renderResult === undefined) {
    throw new Error('Research scout renderer was not registered');
  }

  const testTheme = new Theme({
    accent: 0, border: 0, borderAccent: 0, borderMuted: 0, success: 0, error: 0, warning: 0,
    muted: 0, dim: 0, text: 0, thinkingText: 0, userMessageText: 0, customMessageText: 0,
    customMessageLabel: 0, toolTitle: 0, toolOutput: 0, mdHeading: 0, mdLink: 0, mdLinkUrl: 0,
    mdCode: 0, mdCodeBlock: 0, mdCodeBlockBorder: 0, mdQuote: 0, mdQuoteBorder: 0, mdHr: 0,
    mdListBullet: 0, toolDiffAdded: 0, toolDiffRemoved: 0, toolDiffContext: 0, syntaxComment: 0,
    syntaxKeyword: 0, syntaxFunction: 0, syntaxVariable: 0, syntaxString: 0, syntaxNumber: 0,
    syntaxType: 0, syntaxOperator: 0, syntaxPunctuation: 0, thinkingOff: 0, thinkingMinimal: 0,
    thinkingLow: 0, thinkingMedium: 0, thinkingHigh: 0, thinkingXhigh: 0, bashMode: 0,
  }, {
    selectedBg: 0, userMessageBg: 0, customMessageBg: 0, toolPendingBg: 0, toolSuccessBg: 0,
    toolErrorBg: 0,
  }, 'truecolor');
  const context: Parameters<typeof renderResult>[3] = {
    args: {},
    toolCallId: 'test-call',
    invalidate: () => undefined,
    lastComponent: undefined,
    state: undefined,
    cwd: '/project',
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    isError: false,
    showImages: false,
  };
  const partial = renderResult({
    content: [{type: 'text', text: 'final answer'}],
    details: {
      agent: 'reviewer',
      model: 'provider/model',
      progress: 'secret thinking transcript',
      activity: {
        currentAction: 'Reading agent/auth/session.ts',
        elapsedMs: 23_000,
        spinnerIndex: 2,
        filesRead: 2,
        searches: 3,
        listings: 0,
      },
      usage: {
        input: 12_430,
        output: 1842,
        cacheRead: 8200,
        cacheWrite: 0,
        contextTokens: 14_272,
        cost: 0.0421,
        turns: 2,
      },
    },
  }, {expanded: false, isPartial: true}, testTheme, context).render(200).join('\n');

  t.assert.match(partial, /Reading agent\/auth\/session\.ts/v);
  t.assert.match(partial, /2 files · 3 searches · 2 turns/v);
  t.assert.match(partial, /↑12,430 ↓1,842 R8,200 W0 \$0\.0421 ctx:14,272/v);
  t.assert.doesNotMatch(partial, /secret thinking transcript/v);

  const aborted = renderResult({
    content: [{type: 'text', text: 'Aborted after 17s.'}],
    details: {},
  }, {expanded: false, isPartial: false}, testTheme, context).render(200).join('\n');
  t.assert.match(aborted, /⚠ Aborted after 17s/v);
  t.assert.doesNotMatch(aborted, /Research Result/v);

  const legacy = renderResult({
    content: [{type: 'text', text: 'legacy result'}],
    details: {
      agent: 'scout',
      model: 'provider/model',
      progress: 'old activity',
    },
  }, {expanded: false, isPartial: false}, testTheme, context).render(200).join('\n');
  t.assert.match(legacy, /Completed/v);
  t.assert.match(legacy, /legacy result/v);
});

void test('registers /sandbox to manage access during a session', (t: TestContext) => {
  const commands: string[] = [];

  sandboxExtension({
    on() {
      return undefined;
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerTool() {
      return undefined;
    },
  } as unknown as Parameters<typeof sandboxExtension>[0]);

  t.assert.deepStrictEqual(commands, ['sandbox']);
});

