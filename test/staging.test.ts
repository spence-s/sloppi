import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {StagingCommand} from '../agent/extensions/staging/command.ts';
import {StagingConfig, type StagingRule} from '../agent/extensions/staging/config.ts';
import {Staging} from '../agent/extensions/staging/index.ts';
import {findStagedInvocations, stagingParseLimit} from '../agent/extensions/staging/parser.ts';

/** Returns matched selector names for concise parser assertions. */
function matches(command: string, rules: StagingRule[] = [{command: 'acli'}, {command: 'gh auth'}]): string[] {
  return [...new Set(findStagedInvocations(command, rules).flatMap(match => match.selectors))];
}

void describe('staging parser', () => {
  void test('finds literal commands in all required executable positions', (t: TestContext) => {
    const commands = [
      'acli confluence space list --json',
      '/opt/homebrew/bin/acli confluence space list --json',
      'FOO=bar acli confluence page view --id 123',
      'acli status | jq .',
      'gh auth status && echo done',
      'echo "$(gh auth status)"',
      'echo `gh auth status`',
      'cat <(acli confluence space list --json)',
      'if gh auth status; then echo yes; fi',
      '\'acli\' status',
    ];

    t.assert.deepStrictEqual(
      commands.filter(command => matches(command).length === 0),
      [],
    );
  });

  void test('ignores strings, dynamic commands, wrappers, and nonmatching prefixes', (t: TestContext) => {
    const commands = [
      'printf \'%s\' \'acli confluence space list\'',
      'echo \'gh auth login\'',
      '$CLI confluence space list',
      'eval "$COMMAND"',
      'env gh auth status',
      'bash -c \'gh auth status\'',
      'xargs gh auth <<< \'status\'',
      '# acli confluence space list',
      'gh repo view',
    ];

    t.assert.deepStrictEqual(
      commands.filter(command => matches(command).length > 0),
      [],
    );
  });

  void test('rejects uncertain or unsupported input', (t: TestContext) => {
    t.assert.deepStrictEqual(matches('gh auth status &&'), []);
    t.assert.deepStrictEqual(matches('echo "$(gh auth status &&)"'), []);
    t.assert.deepStrictEqual(matches('gh auth\nstatus'), []);
    t.assert.deepStrictEqual(matches('gh auth\u{0}status'), []);
    t.assert.deepStrictEqual(matches(`gh auth ${'x'.repeat(stagingParseLimit)}`), []);
  });

  void test('applies literal passthrough sequences without weakening neighboring commands', (t: TestContext) => {
    const rules: StagingRule[] = [{
      command: 'acli confluence',
      passthrough: ['-h', '--help', 'schema list'],
    }];

    t.assert.deepStrictEqual(matches('acli confluence page view -h', rules), []);
    t.assert.deepStrictEqual(matches('acli confluence \'--help\'', rules), []);
    t.assert.deepStrictEqual(matches('acli confluence schema list', rules), []);
    t.assert.deepStrictEqual(matches('acli confluence schema other list', rules), ['acli confluence']);
    t.assert.deepStrictEqual(matches('acli confluence -- --help', rules), ['acli confluence']);
    t.assert.deepStrictEqual(matches('acli confluence "$FLAG"', rules), ['acli confluence']);
    t.assert.deepStrictEqual(
      matches('acli confluence -h && acli confluence page view', rules),
      ['acli confluence'],
    );
    t.assert.deepStrictEqual(matches('acli --verbose confluence -h', rules), []);
  });

  void test('keeps overlapping rules stage-wins', (t: TestContext) => {
    const rules: StagingRule[] = [
      {command: 'acli'},
      {command: 'acli confluence', passthrough: ['--help']},
    ];

    t.assert.deepStrictEqual(matches('acli confluence --help', rules), ['acli']);
  });

  void test('requires the complete literal selector prefix', (t: TestContext) => {
    t.assert.deepStrictEqual(matches('gh auth login'), ['gh auth']);
    t.assert.deepStrictEqual(matches('gh "$ACTION" login'), []);
    t.assert.deepStrictEqual(matches('gh repo view'), []);
  });
});

void describe('staging configuration', () => {
  void test('combines scopes, deduplicates, and writes atomically', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const path = join(directory, 'staging.json');
    const global = new StagingConfig('/project', path);
    const project = new StagingConfig('/project', path);

    try {
      await Promise.all([
        global.replaceRules('global', [{command: 'acli'}, {command: 'gh auth'}]),
        project.replaceRules('project', [{command: 'gh auth', passthrough: ['--help']}, {command: 'gh'}]),
      ]);
      await global.reload();

      t.assert.deepStrictEqual(global.getEffectiveRules(), [
        {command: 'acli'},
        {command: 'gh auth'},
        {command: 'gh auth', passthrough: ['--help']},
        {command: 'gh'},
      ]);
      t.assert.deepStrictEqual(JSON.parse(await readFile(path, 'utf8')) as unknown, {
        commands: [{command: 'acli'}, {command: 'gh auth'}],
        projects: {'/project': {commands: [{command: 'gh auth', passthrough: ['--help']}, {command: 'gh'}]}},
      });
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('treats a missing file as empty and defaults outside the project', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    try {
      const config = new StagingConfig(directory, join(directory, 'missing.json'));
      await config.reload();
      t.assert.deepStrictEqual(config.getEffectiveRules(), []);

      const defaultConfig = new StagingConfig('/tmp/project');
      t.assert.strictEqual(defaultConfig.path, join(homedir(), '.pi', 'staging.json'));
      t.assert.ok(!defaultConfig.path.startsWith('/tmp/project/'));
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('rejects invalid selectors and malformed policy without replacing valid data', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const path = join(directory, 'staging.json');
    const config = new StagingConfig('/project', path);

    try {
      await config.replaceRules('global', [{command: 'acli'}]);
      const invalidWrites = await Promise.allSettled(['', 'gh && rm', '"acli"', '$CLI', 'gh\tauth', '/usr/bin/acli']
        .map(async command => config.replaceRules('global', [{command}])));
      t.assert.ok(invalidWrites.every(result => result.status === 'rejected'
        && result.reason instanceof Error
        && result.reason.message.includes('Invalid staging command')));
      await t.assert.rejects(
        config.replaceRules('global', [{command: 'acli', passthrough: ['$FLAG']}]),
        /Invalid passthrough/v,
      );
      await t.assert.rejects(
        config.replaceRules('global', [{command: 'acli'}, {command: 'acli'}]),
        /Duplicate staging command/v,
      );

      t.assert.deepStrictEqual(JSON.parse(await readFile(path, 'utf8')) as unknown, {
        commands: [{command: 'acli'}],
      });

      await writeFile(path, JSON.stringify({commands: ['acli'], unknown: true}));
      await t.assert.rejects(config.reload(), /Unknown staging configuration field/v);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

/** Captures extension handlers without giving staging any process-execution API. */
function createLifecycleHarness(staging: Staging): {
  ctx: ExtensionContext;
  editor: () => string;
  events: Map<string, EventHandler>;
  notifications: string[];
} {
  const events = new Map<string, EventHandler>();
  const notifications: string[] = [];
  let editor = '';
  const pi = staging.pi as unknown as {
    on: (name: string, handler: EventHandler) => void;
    registerCommand: () => void;
  };
  pi.on = (name, handler) => {
    events.set(name, handler);
  };

  pi.registerCommand = () => undefined;
  staging.register();

  const ctx = {
    ui: {
      getEditorText: () => editor,
      notify(message: string) {
        notifications.push(message);
      },
      setEditorText(value: string) {
        editor = value;
      },
      setStatus() {
        return undefined;
      },
      theme: {fg: (_color: string, value: string) => value},
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    editor: () => editor,
    events,
    notifications,
  };
}

/** Builds the typed Bash event used by lifecycle checks. */
function bashEvent(command: string): ToolCallEvent {
  return {
    input: {command}, toolCallId: 'bash-1', toolName: 'bash', type: 'tool_call',
  };
}

void describe('staging lifecycle', () => {
  void test('loads before permissions without host execution APIs', async (t: TestContext) => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      pi: {extensions: string[]};
    };
    const stagingIndex = packageJson.pi.extensions.indexOf('./agent/extensions/staging/index.ts');
    const permissionsIndex = packageJson.pi.extensions.indexOf('./agent/extensions/permissions/index.ts');
    const implementation = await readFile(new URL('../agent/extensions/staging/index.ts', import.meta.url), 'utf8');

    t.assert.notStrictEqual(stagingIndex, -1);
    t.assert.ok(stagingIndex < permissionsIndex);
    t.assert.doesNotMatch(implementation, /child_process|createLocalBashOperations|execa|pi\.exec|\.abort\(/v);
  });

  void test('blocks, terminates, settles into the editor, and does not execute', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const config = new StagingConfig('/project', join(directory, 'staging.json'));
    const staging = new Staging({} as ExtensionAPI, config);

    try {
      await config.replaceRules('global', [{command: 'acli'}]);
      const harness = createLifecycleHarness(staging);
      const toolCall = harness.events.get('tool_call');
      const settled = harness.events.get('agent_settled');
      if (toolCall === undefined || settled === undefined) {
        throw new Error('Lifecycle handlers not registered');
      }

      const result = await toolCall(bashEvent('acli status') as never, harness.ctx) as ToolCallEventResult;
      t.assert.strictEqual(result.block, true);
      t.assert.strictEqual(result.terminate, true);
      t.assert.strictEqual(harness.editor(), '');

      settled({type: 'agent_settled'} as never, harness.ctx);
      t.assert.strictEqual(harness.editor(), '!acli status');
      t.assert.match(harness.notifications[0] ?? '', /press Enter only to run/v);

      settled({type: 'agent_settled'} as never, harness.ctx);
      t.assert.strictEqual(harness.editor(), '!acli status');
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('allows nonmatches and configured passthroughs and ignores non-Bash tools', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const config = new StagingConfig('/project', join(directory, 'staging.json'));
    const staging = new Staging({} as ExtensionAPI, config);

    try {
      await config.replaceRules('global', [{command: 'acli', passthrough: ['-h', '--help']}]);
      const harness = createLifecycleHarness(staging);
      const toolCall = harness.events.get('tool_call');
      if (toolCall === undefined) {
        throw new Error('tool_call handler not registered');
      }

      t.assert.strictEqual(await toolCall(bashEvent('npm test') as never, harness.ctx), undefined);
      t.assert.strictEqual(await toolCall(bashEvent('acli confluence -h') as never, harness.ctx), undefined);
      t.assert.strictEqual(await toolCall({
        input: {}, toolCallId: 'read-1', toolName: 'read', type: 'tool_call',
      } as never, harness.ctx), undefined);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('preserves editor text and stages only the first parallel match', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const config = new StagingConfig('/project', join(directory, 'staging.json'));
    const staging = new Staging({} as ExtensionAPI, config);

    try {
      await config.replaceRules('global', [{command: 'acli'}]);
      const harness = createLifecycleHarness(staging);
      const toolCall = harness.events.get('tool_call');
      if (toolCall === undefined) {
        throw new Error('tool_call handler not registered');
      }

      await toolCall(bashEvent('acli first') as never, harness.ctx);
      await toolCall(bashEvent('acli second') as never, harness.ctx);
      harness.ctx.ui.setEditorText('my draft');
      staging.settle(harness.ctx);

      t.assert.strictEqual(harness.editor(), 'my draft');
      t.assert.match(harness.notifications[0] ?? '', /additional host-routed command was blocked/v);
      t.assert.strictEqual(staging.pending, undefined);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

void describe('/staging command', () => {
  void test('adds scoped rules and shows effective settings in a simple menu', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-staging-test-'));
    const config = new StagingConfig('/project', join(directory, 'staging.json'));
    const notifications: Array<{message: string; level: string}> = [];
    const menus: string[][] = [];
    const selections: Array<string | undefined> = ['+ Stage a command for host review', undefined];
    const inputs = ['acli confluence', '-h; --help'];
    let handler: ((arguments_: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    new StagingCommand(config).register({
      registerCommand(_name, options) {
        handler = options.handler;
      },
    } as ExtensionAPI);
    const ctx = {
      mode: 'tui',
      ui: {
        confirm: async () => true,
        input: async () => inputs.shift(),
        notify(message: string, level: string) {
          notifications.push({level, message});
        },
        async select(_title: string, options: string[]) {
          menus.push(options);
          return selections.shift();
        },
        setStatus() {
          return undefined;
        },
        theme: {fg: (_color: string, value: string) => value},
      },
    } as unknown as ExtensionCommandContext;

    try {
      if (handler === undefined) {
        throw new Error('/staging was not registered');
      }

      await config.replaceRules('global', [{command: 'gh auth'}]);
      await handler('', ctx);
      await config.reload();
      t.assert.deepStrictEqual(config.getScopedRules('project'), [{
        command: 'acli confluence',
        passthrough: ['-h', '--help'],
      }]);
      t.assert.ok(menus.at(-1)?.some(item => item.includes('acli confluence') && item.includes('-h')));
      t.assert.ok(menus.at(-1)?.some(item => item.includes('gh auth')));

      await handler('other', ctx);
      t.assert.ok(notifications.some(item => item.level === 'error'));
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});
