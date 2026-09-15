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
import {setTimeout as delay} from 'node:timers/promises';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {execa} from 'execa';
import {chromium} from 'playwright';
import {
  initTheme,
  Theme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type LsToolDetails,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {discoverResearchAgents} from '../agent/extensions/sandbox/agents.ts';
import {SandboxCommand} from '../agent/extensions/sandbox/command.ts';
import {ConfigStore} from '../agent/extensions/sandbox/config.ts';
import sandboxExtension, {Sandbox as SandboxExtension} from '../agent/extensions/sandbox/index.ts';
import {PlaywrightBridge} from '../agent/extensions/sandbox/playwright.ts';
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

void test('lets projects override or inherit the global research-agent setting', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-agent-toggle-test-'));
  const path = join(directory, 'sandbox.json');
  const config = new ConfigStore('/project', path);

  try {
    await config.load();
    t.assert.strictEqual(config.areResearchAgentsEnabled(), false);
    await config.setResearchAgentsEnabled('global', true);
    t.assert.strictEqual(config.areResearchAgentsEnabled(), true);
    await config.setResearchAgentsEnabled('project', false);
    t.assert.strictEqual(config.areResearchAgentsEnabled(), false);
    await config.setResearchAgentsEnabled('project', undefined);
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

void test('runs commands directly on the host while sandboxing is off', async (t: TestContext) => {
  const sandbox = new SandboxSessionManager(process.cwd(), new ConfigStore(process.cwd()));
  await sandbox.setEnabled(false);
  const result = await sandbox.run`printf host`;

  t.assert.strictEqual(result.stdout, 'host');
  t.assert.strictEqual(sandbox.session, undefined);
});

/**
 Ensures every successful SRT wrapper is cleaned up across all command outcomes.
 */
void test('balances sandbox wrapper cleanup', async (t: TestContext) => {
  const sandbox = new SandboxSessionManager(process.cwd(), new ConfigStore(process.cwd()));
  sandbox.session = {
    previousClaudeCodeTmpdir: undefined,
    previousTmpdir: undefined,
    scratchPath: process.cwd(),
  };
  let cleanupCount = 0;
  let shouldFailPipeWrap = false;
  t.mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => {
    if (shouldFailPipeWrap && command === '\'cat\'') {
      throw new Error('pipe wrap failed');
    }

    return command;
  });
  t.mock.method(SandboxManager, 'cleanupAfterCommand', () => {
    cleanupCount++;
  });

  const success = await sandbox.run`printf success`;
  t.assert.strictEqual(success.stdout, 'success');
  t.assert.strictEqual(cleanupCount, 1);

  const pipeline = await sandbox.run({cwd: process.cwd(), pipe: ['cat']})`printf pipeline`;
  t.assert.strictEqual(pipeline.stdout, 'pipeline');
  t.assert.strictEqual(cleanupCount, 3);

  await t.assert.rejects(
    sandbox.run({cwd: process.cwd(), timeout: 0.01})`sleep 1`,
    /timeout:0\.01/v,
  );
  t.assert.strictEqual(cleanupCount, 4);

  const controller = new AbortController();
  const canceled = sandbox.run({cwd: process.cwd(), signal: controller.signal})`sleep 1`;
  controller.abort();
  await t.assert.rejects(canceled, /aborted/v);
  t.assert.strictEqual(cleanupCount, 5);

  shouldFailPipeWrap = true;
  await t.assert.rejects(
    sandbox.run({cwd: process.cwd(), pipe: ['cat']})`printf never-runs`,
    /pipe wrap failed/v,
  );
  t.assert.strictEqual(cleanupCount, 6);
});

/**
 Verifies sandboxed commands stream output and honor Bash cancellation controls.
 */
void test('streams, times out, and cancels sandboxed commands', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-command-test-'));
  const sandbox = new SandboxSessionManager(directory, new ConfigStore(directory));
  sandbox.session = {
    previousClaudeCodeTmpdir: undefined,
    previousTmpdir: undefined,
    scratchPath: directory,
  };
  t.mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => command);

  try {
    const tools = new SandboxTools({} as ExtensionAPI, directory, sandbox);
    const operations = tools.bashOperations;
    const largeContent = 'x'.repeat(3_000_000);
    const largePath = join(directory, 'large.txt');
    await tools.writeOperations.writeFile(largePath, largeContent);
    const savedLargeContent = await readFile(largePath);
    t.assert.strictEqual(savedLargeContent.length, largeContent.length);

    let streamed = '';
    const {promise: firstChunk, resolve: receivedFirstChunk} = Promise.withResolvers<void>();
    let isSettled = false;
    const running = operations.exec('printf first; sleep 0.2; printf second', directory, {
      onData(data) {
        streamed += data.toString();
        if (streamed.includes('first')) {
          receivedFirstChunk();
        }
      },
    });
    void running.then(() => {
      isSettled = true;
    });

    await firstChunk;
    t.assert.strictEqual(isSettled, false);
    const result = await running;
    t.assert.strictEqual(result.exitCode, 0);
    t.assert.strictEqual(streamed, 'firstsecond');

    await t.assert.rejects(
      operations.exec('sleep 1', directory, {
        onData() {
          // This command intentionally emits no output.
        },
        timeout: 0.01,
      }),
      /timeout:0\.01/v,
    );

    const controller = new AbortController();
    const {promise: descendantReady, resolve: markDescendantReady} = Promise.withResolvers<void>();
    const canceled = operations.exec(
      'trap : HUP; printf ready; sleep 0.2; printf survived > descendant-survived',
      directory,
      {
        onData(data) {
          if (data.includes('ready')) {
            markDescendantReady();
          }
        },
        signal: controller.signal,
      },
    );
    await descendantReady;
    controller.abort();
    await t.assert.rejects(canceled, /aborted/v);
    await delay(300);
    await t.assert.rejects(access(join(directory, 'descendant-survived')), {code: 'ENOENT'});
  } finally {
    sandbox.session = undefined;
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies ls uses one sandboxed system command and preserves its entry limit.
 */
void test('lists 500 entries with one sandbox wrapper', async (t: TestContext) => {
  const directory = await mkdtemp(join(process.cwd(), '.sloppi-ls-test-'));
  const sandbox = new SandboxSessionManager(directory, new ConfigStore(directory));
  sandbox.session = {
    previousClaudeCodeTmpdir: undefined,
    previousTmpdir: undefined,
    scratchPath: directory,
  };
  let wrapperCount = 0;
  t.mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => {
    wrapperCount++;
    return command;
  });

  try {
    const target = join(directory, '000-directory');
    await mkdir(target);
    await symlink(target, join(directory, '000-directory-link'));
    await symlink(join(directory, 'missing'), join(directory, '000-broken-link'));
    await Promise.all(Array.from({length: 498}, async (_, index) =>
      writeFile(join(directory, `file-${String(index).padStart(3, '0')}`), '')));

    const tools = new SandboxTools({} as ExtensionAPI, directory, sandbox);
    const result = await tools.ls.execute('ls-test', {path: directory, limit: 500});
    const output = result.content[0];
    t.assert.strictEqual(output?.type, 'text');
    if (output?.type !== 'text') {
      throw new Error('ls did not return text');
    }

    t.assert.strictEqual(wrapperCount, 1);
    t.assert.strictEqual(output.text.split('\n\n[', 1)[0]?.split('\n', 501).length, 500);
    t.assert.match(output.text, /000-directory\//v);
    t.assert.match(output.text, /000-directory-link\n/v);
    t.assert.match(output.text, /000-broken-link/v);
    t.assert.doesNotMatch(output.text, /file-497/v);
    t.assert.deepStrictEqual(result.details, {entryLimitReached: 500});

    const byteDirectory = join(directory, 'large-names');
    await mkdir(byteDirectory);
    await Promise.all(Array.from({length: 260}, async (_, index) =>
      writeFile(join(byteDirectory, `${String(index).padStart(3, '0')}-${'x'.repeat(196)}`), '')));
    const byteResult = await tools.ls.execute('ls-byte-test', {path: byteDirectory, limit: 500});
    const byteDetails = byteResult.details as LsToolDetails | undefined;
    t.assert.strictEqual(wrapperCount, 2);
    t.assert.strictEqual(byteDetails?.entryLimitReached, undefined);
    t.assert.strictEqual(byteDetails?.truncation?.truncatedBy, 'bytes');
    t.assert.strictEqual(byteDetails?.truncation?.totalLines, 260);
    t.assert.ok((byteDetails?.truncation?.outputBytes ?? Infinity) <= 50 * 1024);
  } finally {
    sandbox.session = undefined;
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies sandboxed find preserves Pi glob semantics and repository ignores.
 */
void test('matches brace globs with sandboxed find', async (t: TestContext) => {
  const directory = await mkdtemp(join(process.cwd(), '.sloppi-find-test-'));
  const sandbox = new SandboxSessionManager(directory, new ConfigStore(directory));
  sandbox.session = {
    previousClaudeCodeTmpdir: undefined,
    previousTmpdir: undefined,
    scratchPath: directory,
  };
  const commands: string[] = [];
  t.mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => {
    commands.push(command);
    return command;
  });

  try {
    await mkdir(join(directory, 'src'), {recursive: true});
    await mkdir(join(directory, 'node_modules'), {recursive: true});
    await writeFile(join(directory, '.gitignore'), 'ignored.ts\n');
    await writeFile(join(directory, 'src', 'app.ts'), '');
    await writeFile(join(directory, 'src', 'app.js'), '');
    await writeFile(join(directory, 'src', 'app.css'), '');
    await writeFile(join(directory, 'ignored.ts'), '');
    await writeFile(join(directory, 'node_modules', 'package.ts'), '');

    const operations = new SandboxTools({} as ExtensionAPI, directory, sandbox).findOperations;
    const options = {ignore: ['**/node_modules/**', '**/.git/**'], limit: 10};
    const matches = await operations.glob('**/*.{js,ts}', directory, options);
    t.assert.deepStrictEqual(new Set(matches), new Set(['src/app.js', 'src/app.ts']));

    const nested = await operations.glob('src/**/*.ts', directory, {...options, limit: 1});
    t.assert.deepStrictEqual(nested, ['src/app.ts']);
    t.assert.ok(commands.includes('\'head\' \'-n\' \'1\''));

    const emptyDirectory = join(directory, 'empty');
    await mkdir(emptyDirectory);
    t.assert.deepStrictEqual(await operations.glob('*.ts', emptyDirectory, options), []);
  } finally {
    sandbox.session = undefined;
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies sandboxed grep uses ripgrep limits and stops promptly when aborted.
 */
void test('bounds and cancels sandboxed grep', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-grep-test-'));
  const sandbox = new SandboxSessionManager(directory, new ConfigStore(directory));
  sandbox.session = {
    previousClaudeCodeTmpdir: undefined,
    previousTmpdir: undefined,
    scratchPath: directory,
  };
  let shouldBlockRipgrep = false;
  const commands: string[] = [];
  const {promise: ripgrepStarted, resolve: markRipgrepStarted} = Promise.withResolvers<void>();
  t.mock.method(SandboxManager, 'wrapWithSandbox', async (command: string) => {
    commands.push(command);
    if (shouldBlockRipgrep && command.startsWith('\'rg\' ')) {
      markRipgrepStarted();
      return 'sleep 10';
    }

    return command;
  });

  try {
    const grep = new SandboxTools({} as ExtensionAPI, directory, sandbox).grepExecute;
    const longLine = `needle ${'x'.repeat(1000)}`;
    const path = join(directory, 'grep.txt');
    await writeFile(path, ['before', longLine, 'after', 'needle second', 'tail', 'needle third'].join('\n'));

    const limited = await grep('limited', {
      pattern: 'needle',
      path,
      context: 1,
      limit: 2,
    }, undefined);
    const limitedText = limited.content.find(entry => entry.type === 'text')?.text ?? '';
    t.assert.strictEqual(limitedText.matchAll(/:\d+:/gv).toArray().length, 2);
    t.assert.ok(commands.includes('\'head\' \'-n\' \'2\''));
    t.assert.match(limitedText, /\[truncated\]/v);
    t.assert.doesNotMatch(limitedText, new RegExp('x'.repeat(600), 'v'));

    // `rg --max-count` would return two matches from each file; Pi promises two in total.
    await writeFile(join(directory, 'second.txt'), 'needle fourth\nneedle fifth\n');
    const globalLimit = await grep('global-limit', {
      pattern: 'needle',
      path: directory,
      limit: 2,
    }, undefined);
    const globalText = globalLimit.content.find(entry => entry.type === 'text')?.text ?? '';
    t.assert.strictEqual(globalText.matchAll(/:\d+:/gv).toArray().length, 2);
    t.assert.match(globalText, /2 matches limit reached/v);

    await writeFile(path, `${Array.from({length: 110}, () => longLine).join('\n')}\n`);
    const bounded = await grep('bounded', {
      pattern: 'needle',
      path,
      context: 1,
      limit: 100,
    }, undefined);
    const boundedText = bounded.content.find(entry => entry.type === 'text')?.text ?? '';
    t.assert.match(boundedText, /50(?:\.0)?KB limit reached/v);

    shouldBlockRipgrep = true;
    const controller = new AbortController();
    const canceled = grep('canceled', {pattern: 'needle', path}, controller.signal);
    await ripgrepStarted;
    await delay(20);
    controller.abort();
    await t.assert.rejects(canceled, /Operation aborted/v);
  } finally {
    sandbox.session = undefined;
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies the bridge exposes the native CLI and closes its managed browser.
 */
void test('configures the sandboxed Playwright CLI for host Chrome', async (t: TestContext) => {
  const config = new ConfigStore('/project');
  config.hasLoaded = true;
  const bridge = new PlaywrightBridge(config);
  let launchOptions: Parameters<typeof chromium.launchServer>[0];
  let didClose = false;
  const browser = {
    async close() {
      didClose = true;
    },
    wsEndpoint() {
      return 'ws://127.0.0.1:4321/session';
    },
  };

  t.mock.method(SandboxManager, 'getProxyPort', () => 1234);
  t.mock.method(SandboxManager, 'getProxyAuthToken', () => 'token');
  t.mock.method(SandboxManager, 'getMitmCA', () => undefined);
  t.mock.method(chromium, 'launchServer', async (options: Parameters<typeof chromium.launchServer>[0]) => {
    launchOptions = options;
    return browser;
  });

  try {
    t.assert.strictEqual(await bridge.start(), 'ws://127.0.0.1:4321/session');
    t.assert.deepStrictEqual(launchOptions?.args, [
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
    t.assert.strictEqual(launchOptions?.channel, 'chrome');
    t.assert.strictEqual(launchOptions?.chromiumSandbox, true);
    t.assert.strictEqual(launchOptions?.headless, true);
    t.assert.strictEqual(launchOptions?.host, '127.0.0.1');
    t.assert.strictEqual(launchOptions?.proxy?.server, 'http://127.0.0.1:1234');
    t.assert.strictEqual(launchOptions?.proxy?.username, 'srt');
    t.assert.strictEqual(launchOptions?.proxy?.password, 'token');
  } finally {
    await bridge.stop();
  }

  t.assert.strictEqual(didClose, true);
});

/**
 Verifies the native Bash tool enables Playwright before invoking its CLI.
 */
void test('prepares Playwright on its first sandboxed CLI command', async (t: TestContext) => {
  const handlers = new Map<string, (...arguments_: unknown[]) => unknown>();
  let starts = 0;
  const bridge = new PlaywrightBridge(new ConfigStore('/project'));
  t.mock.method(bridge, 'start', async () => {
    starts += 1;
    return 'ws://127.0.0.1:4321/session';
  });
  bridge.register({
    on(name: string, handler: (...arguments_: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {
      return undefined;
    },
  } as unknown as ExtensionAPI);

  const handler = handlers.get('tool_call');
  if (handler === undefined) {
    throw new Error('tool_call handler was not registered');
  }

  const input = {command: ['test', '-f', '"$PLAYWRIGHT_MCP_CONFIG"', '&&', 'printf', 'playwright-cli'].join(' ')};
  await handler({toolCallId: 'playwright', toolName: 'bash', input});
  t.assert.strictEqual(starts, 1);
  const command: unknown = Reflect.get(input, 'command');
  if (typeof command !== 'string') {
    throw new TypeError('Bash command was not preserved');
  }

  t.assert.match(command, /PLAYWRIGHT_MCP_CONFIG/v);
  t.assert.match(command, /ws:\/\/127\.0\.0\.1:4321\/session/v);
  t.assert.match(command, /test -f "\$PLAYWRIGHT_MCP_CONFIG" && printf playwright-cli$/v);

  const directory = await mkdtemp(join(tmpdir(), 'sloppi-playwright-command-test-'));
  try {
    const result = await execa(command, {env: {...process.env, TMPDIR: directory}, shell: true});
    t.assert.strictEqual(result.stdout, 'playwright-cli');
    const configText = await readFile(join(directory, 'playwright-cli.json'), 'utf8');
    t.assert.deepStrictEqual(JSON.parse(configText), {
      allowUnrestrictedFileAccess: false,
      browser: {
        contextOptions: {
          permissions: [],
          serviceWorkers: 'block',
        },
        remoteEndpoint: 'ws://127.0.0.1:4321/session',
      },
    });
  } finally {
    await rm(directory, {force: true, recursive: true});
  }

  await handler({toolCallId: 'other', toolName: 'bash', input: {command: 'printf browser'}});
  t.assert.strictEqual(starts, 1);
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

void test('canonicalizes read paths before sandbox execution', async (t: TestContext) => {
  const directory = await mkdtemp(join(process.cwd(), '.sloppi-read-path-test-'));
  const target = join(directory, 'target');
  const alias = join(directory, 'alias');
  const arguments_: unknown[] = [];
  const sandbox = {
    /**
     Captures the path passed through the sandbox command template.
     */
    async run(_strings: TemplateStringsArray, ...values: unknown[]) {
      arguments_.push(...values);
      return {exitCode: 0, stderr: '', stdout: ''};
    },
  } as unknown as SandboxSessionManager;

  try {
    await mkdir(target);
    await writeFile(join(target, 'file.txt'), 'test\n');
    await symlink(target, alias);
    await new SandboxTools({} as ExtensionAPI, directory, sandbox).readOperations.access(join(alias, 'file.txt'));
    t.assert.strictEqual(arguments_[0], join(target, 'file.txt'));
  } finally {
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

/**
 Verifies each friendly access level replaces conflicting settings for the same path.
 */
void test('sets one filesystem access level per location', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);

  try {
    await configStore.setFilesystemAccess('project', '/shared', 'readOnly');
    let {filesystem} = configStore.getScopedSrtConfig('project');
    t.assert.deepStrictEqual(filesystem?.allowRead, ['/shared']);
    t.assert.deepStrictEqual(filesystem?.denyWrite, ['/shared']);

    await configStore.setFilesystemAccess('project', '/shared', 'readWrite');
    filesystem = configStore.getScopedSrtConfig('project').filesystem;
    t.assert.deepStrictEqual(filesystem?.allowRead, ['/shared']);
    t.assert.deepStrictEqual(filesystem?.allowWrite, ['/shared']);
    t.assert.deepStrictEqual(filesystem?.denyWrite, []);

    await configStore.setFilesystemAccess('project', '/shared', 'none');
    filesystem = configStore.getScopedSrtConfig('project').filesystem;
    t.assert.deepStrictEqual(filesystem?.allowRead, []);
    t.assert.deepStrictEqual(filesystem?.allowWrite, []);
    t.assert.deepStrictEqual(filesystem?.denyRead, ['/shared']);
    t.assert.deepStrictEqual(filesystem?.denyWrite, ['/shared']);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('resets one configuration scope', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);

  try {
    await configStore.updateDomain('project', 'deny', 'add', 'blocked.example.com');
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

    extension.sandbox.isEnabled = false;
    const hostResult = await handler({systemPrompt: 'base'}) as {systemPrompt: string};
    t.assert.match(hostResult.systemPrompt, /Sandbox is OFF/v);
    t.assert.match(hostResult.systemPrompt, /directly on the host/v);
    const toolCall = handlers.get('tool_call');
    t.assert.strictEqual(await toolCall?.({toolName: 'unapproved_extension_tool'}), undefined);
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
    isEnabled: true,
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

void test('/sandbox toggles host execution and updates its status', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  let handler: Handler | undefined;
  let bridgeStops = 0;
  const statuses: string[] = [];
  const config = new ConfigStore('/project');
  const sandbox = new SandboxSessionManager('/project', config);
  t.mock.method(sandbox, 'setEnabled', async (isNextEnabled: boolean) => {
    sandbox.isEnabled = isNextEnabled;
  });
  const playwright = new PlaywrightBridge(config);
  t.mock.method(playwright, 'stop', async () => {
    bridgeStops++;
  });

  new SandboxCommand(config, sandbox, playwright).register({
    registerCommand(_name: string, options: {handler: Handler}) {
      handler = options.handler;
    },
  } as unknown as ExtensionAPI);
  if (handler === undefined) {
    throw new Error('/sandbox handler was not registered');
  }

  const ctx = {
    ui: {
      confirm: async () => true,
      notify() {
        return undefined;
      },
      setStatus(_id: string, status: string) {
        statuses.push(status);
      },
      theme: {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      },
    },
  } as unknown as ExtensionCommandContext;

  await handler('off', ctx);
  t.assert.strictEqual(sandbox.isEnabled, false);
  t.assert.strictEqual(bridgeStops, 1);
  t.assert.match(statuses.at(-1) ?? '', /󰒲 sandbox off/v);

  await handler('on', ctx);
  t.assert.strictEqual(sandbox.isEnabled, true);
  t.assert.match(statuses.at(-1) ?? '', /󰕥 sandbox/v);
});

void test('/sandbox mutates projects by default and global configuration only when requested', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-command-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);
  const selections: Array<string | undefined> = [
    'Ask when a website is blocked — Use global setting (On)',
    'Off',
    undefined,
    'Ask when a website is blocked — On',
    'Off',
    undefined,
  ];
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
      sandbox: {promptOnNetworkDeny: boolean};
      projects: Record<string, {sandbox: {promptOnNetworkDeny: boolean}}>;
    };
    t.assert.strictEqual(saved.projects['/project']?.sandbox.promptOnNetworkDeny, false);
    t.assert.strictEqual(saved.sandbox.promptOnNetworkDeny, false);
    t.assert.strictEqual(restarts, 2);
    t.assert.match(notifications.at(-1) ?? '', /Use \/sandbox/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

/**
 Verifies project research-agent settings take effect immediately and can return to inheritance.
 */
void test('/sandbox configures research agents globally or per project', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-command-test-'));
  const configPath = join(directory, 'sandbox.json');
  const configStore = new ConfigStore('/project', configPath);
  const selections: Array<string | undefined> = [
    'Research agents — Off',
    'Turn on',
    undefined,
    'Research agents — Use global setting (On)',
    'Turn off',
    undefined,
    'Research agents — Off',
    'Use global setting',
    undefined,
  ];
  const notifications: string[] = [];
  let activeTools = ['read'];
  let handler: Handler | undefined;

  new SandboxCommand(configStore, {} as SandboxSessionManager).register({
    getActiveTools() {
      return activeTools;
    },
    registerCommand(_name: string, options: {handler: Handler}) {
      handler = options.handler;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI);

  const ctx = {
    ui: {
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

    await handler('global', ctx);
    t.assert.deepStrictEqual(activeTools, ['read', 'research_scout']);
    await handler('', ctx);
    t.assert.deepStrictEqual(activeTools, ['read']);
    await handler('', ctx);
    t.assert.deepStrictEqual(activeTools, ['read', 'research_scout']);

    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      sandbox: {researchAgentsEnabled: boolean};
      projects: Record<string, {sandbox: {researchAgentsEnabled?: boolean}}>;
    };
    t.assert.strictEqual(saved.sandbox.researchAgentsEnabled, true);
    t.assert.strictEqual(saved.projects['/project']?.sandbox.researchAgentsEnabled, undefined);
    t.assert.match(notifications.at(-1) ?? '', /use the global setting and are on/v);
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

void test('registers session commands', (t: TestContext) => {
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

  t.assert.deepStrictEqual(commands, ['sandbox', 'playwright']);
});

