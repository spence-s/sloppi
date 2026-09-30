import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxAdvancedCommand} from '../agent/extensions/sandbox/command/advanced.ts';
import {ConfigStore} from '../agent/extensions/sandbox/config.ts';

void test('lets projects override or inherit global research settings', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-research-settings-test-'));
  const config = new ConfigStore('/project', join(directory, 'sandbox.json'));

  try {
    t.assert.strictEqual(config.areResearchAgentsEnabled(), false);
    await config.setResearchAgentsEnabled('global', true);
    t.assert.strictEqual(config.areResearchAgentsEnabled(), true);
    await config.setResearchAgentsEnabled('project', false);
    t.assert.strictEqual(config.areResearchAgentsEnabled(), false);
    await config.setResearchAgentsEnabled('project', undefined);
    t.assert.strictEqual(config.areResearchAgentsEnabled(), true);

    await config.setResearchScoutModel('global', {provider: 'test', id: 'small'});
    await config.setResearchScoutModel('project', {provider: 'test', id: 'local'});
    t.assert.deepStrictEqual(config.getResearchScoutModelSetting('global'), {provider: 'test', id: 'small'});
    t.assert.deepStrictEqual(config.getResearchScoutModel(), {provider: 'test', id: 'local'});

    await config.setResearchScoutModel('project', undefined);
    t.assert.deepStrictEqual(config.getResearchScoutModel(), {provider: 'test', id: 'small'});
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('adds and removes exposed environment variables in one scope', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-environment-test-'));
  const config = new ConfigStore('/project', join(directory, 'sandbox.json'));

  try {
    await config.updateExposedEnv('global', 'add', 'SAFE_GLOBAL');
    await config.updateExposedEnv('project', 'add', 'SAFE_LOCAL');
    t.assert.deepStrictEqual(config.getScopedExposedEnv('global'), ['SAFE_GLOBAL']);
    t.assert.deepStrictEqual(config.getScopedExposedEnv('project'), ['SAFE_LOCAL']);
    t.assert.deepStrictEqual(config.getExposedEnv(), ['SAFE_GLOBAL', 'SAFE_LOCAL']);

    await config.updateExposedEnv('project', 'remove', 'SAFE_LOCAL');
    t.assert.deepStrictEqual(config.getExposedEnv(), ['SAFE_GLOBAL']);
    await t.assert.rejects(config.updateExposedEnv('project', 'add', 'NOT-VALID'), /Invalid sandbox\.exposeEnv/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('toggles host HOME exposure through its dedicated option', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-home-sharing-test-'));
  const config = new ConfigStore('/project', join(directory, 'sandbox.json'));
  const selections = ['On', 'Off'];
  const ctx = {
    ui: {
      notify() {
        return undefined;
      },
      async select() {
        return selections.shift();
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    const advanced = new SandboxAdvancedCommand(config);
    await advanced.manageHostHome(ctx, 'project');
    t.assert.deepStrictEqual(config.getScopedExposedEnv('project'), ['HOME']);

    await advanced.manageHostHome(ctx, 'project');
    t.assert.deepStrictEqual(config.getScopedExposedEnv('project'), []);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('shows the Research Scout model only when research agents are enabled', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-advanced-test-'));
  const config = new ConfigStore('/project', join(directory, 'sandbox.json'));
  const advanced = new SandboxAdvancedCommand(config);
  const menus: string[][] = [];
  const ctx = {
    ui: {
      async select(_title: string, options: string[]) {
        menus.push(options);
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    await config.setResearchAgentsEnabled('global', true);
    await config.setResearchScoutModel('global', {provider: 'test', id: 'small'});
    await config.setResearchAgentsEnabled('project', false);
    await advanced.manage({} as ExtensionAPI, ctx, 'project');
    t.assert.ok(menus[0]?.every(option => !option.startsWith('Research Scout model')));
    t.assert.ok(menus[0]?.includes('Share host home directory — Off (Global)'));

    await config.setResearchAgentsEnabled('project', undefined);
    await advanced.manage({} as ExtensionAPI, ctx, 'project');
    t.assert.ok(menus[1]?.includes('Research Scout model — test/small (Global)'));
    t.assert.ok(menus[1]?.includes('Research agents — On (Global)'));
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('shows effective environment variables and their scope without values', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-environment-view-test-'));
  const path = join(directory, 'sandbox.json');
  await writeFile(path, JSON.stringify({
    sandbox: {exposeEnv: ['HOME', 'SAFE_GLOBAL']},
    projects: {'/project': {sandbox: {exposeEnv: ['SAFE_LOCAL']}}},
  }));
  const renders: string[] = [];
  const ctx = {
    mode: 'tui',
    ui: {
      async custom<T>(factory: (
        tui: {requestRender(): void},
        theme: {bold(text: string): string; fg(color: string, text: string): string},
        keybindings: unknown,
        done: (value: T) => void,
      ) => {render(width: number): string[]}) {
        const component = factory(
          {requestRender: () => undefined},
          {bold: (text: string) => text, fg: (_color: string, text: string) => text},
          {},
          () => undefined,
        );
        renders.push(component.render(160).join('\n'));
        return undefined;
      },
      notify() {
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    initTheme(undefined, false);
    await new SandboxAdvancedCommand(new ConfigStore('/project', path)).manageEnvironment(ctx, 'project');
    const view = renders[0] ?? '';
    t.assert.match(view, /SAFE_GLOBAL/v);
    t.assert.match(view, /SAFE_LOCAL/v);
    t.assert.match(view, /Missing\s+Global/v);
    t.assert.match(view, /Missing\s+Local/v);
    t.assert.match(view, /PATH/v);
    t.assert.match(view, /Available\s+Built in/v);
    t.assert.doesNotMatch(view, /Built in \+ Global/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
