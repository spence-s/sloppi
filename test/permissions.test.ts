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
import {PermissionCommand} from '../agent/extensions/permissions/command.ts';
import {PermissionConfig, type PermissionRule} from '../agent/extensions/permissions/config.ts';
import {Permissions} from '../agent/extensions/permissions/index.ts';
import {findPermissionInvocations, permissionParseLimit} from '../agent/extensions/permissions/parser.ts';

/** Returns matched selector names for concise parser assertions. */
function matches(command: string, rules: PermissionRule[] = [
  {action: 'stage', command: 'acli'},
  {action: 'ask', command: 'gh auth'},
]): string[] {
  return [...new Set(findPermissionInvocations(command, rules).flatMap(match => match.selectors))];
}

/** Creates the minimum interactive context needed by the permission gate. */
function createContext(choice: string | undefined, hasUI = true, steering?: string): ExtensionContext {
  return {
    hasUI,
    ui: {
      input: async () => steering,
      select: async () => choice,
    },
  } as unknown as ExtensionContext;
}

void describe('permission parser', () => {
  void test('finds literal commands in executable positions', (t: TestContext) => {
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

    t.assert.deepStrictEqual(commands.filter(command => matches(command).length === 0), []);
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

    t.assert.deepStrictEqual(commands.filter(command => matches(command).length > 0), []);
  });

  void test('rejects uncertain input and applies literal exceptions', (t: TestContext) => {
    const rules: PermissionRule[] = [{
      action: 'stage',
      command: 'acli confluence',
      passthrough: ['-h', '--help', 'schema list'],
    }];

    t.assert.deepStrictEqual(matches('gh auth status &&'), []);
    t.assert.deepStrictEqual(matches('gh auth\nstatus'), []);
    t.assert.deepStrictEqual(matches(`gh auth ${'x'.repeat(permissionParseLimit)}`), []);
    t.assert.deepStrictEqual(matches('acli confluence page view -h', rules), []);
    t.assert.deepStrictEqual(matches('acli confluence schema list', rules), []);
    t.assert.deepStrictEqual(matches('acli confluence schema other list', rules), ['acli confluence']);
    t.assert.deepStrictEqual(matches('acli confluence -- --help', rules), ['acli confluence']);
    t.assert.deepStrictEqual(matches('acli confluence "$FLAG"', rules), ['acli confluence']);
  });

  void test('keeps overlapping matches for policy resolution', (t: TestContext) => {
    const rules: PermissionRule[] = [
      {action: 'ask', command: 'acli'},
      {action: 'allow', command: 'acli confluence', passthrough: ['--help']},
    ];

    t.assert.deepStrictEqual(matches('acli confluence page view', rules), ['acli', 'acli confluence']);
    t.assert.deepStrictEqual(matches('acli confluence --help', rules), ['acli']);
  });
});

void describe('permission configuration', () => {
  void test('combines scopes, preserves global denials, and writes atomically', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const path = join(directory, 'permissions.json');
    const global = new PermissionConfig('/project', path);
    const project = new PermissionConfig('/project', path);

    try {
      await Promise.all([
        global.replaceRules('global', [
          {action: 'deny', command: 'gh repo delete'},
          {action: 'stage', command: 'acli'},
        ]),
        project.replaceRules('project', [
          {action: 'allow', command: 'gh repo delete'},
          {action: 'ask', command: 'acli'},
        ]),
      ]);
      await global.reload();

      t.assert.deepStrictEqual(global.getEffectiveRules(), [
        {action: 'deny', command: 'gh repo delete'},
        {action: 'ask', command: 'acli'},
      ]);
      t.assert.deepStrictEqual(JSON.parse(await readFile(path, 'utf8')) as unknown, {
        commands: [
          {action: 'deny', command: 'gh repo delete'},
          {action: 'stage', command: 'acli'},
        ],
        projects: {
          '/project': {
            commands: [
              {action: 'allow', command: 'gh repo delete'},
              {action: 'ask', command: 'acli'},
            ],
          },
        },
      });
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('defaults outside the project and rejects malformed policy', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const path = join(directory, 'permissions.json');
    const config = new PermissionConfig('/project', path);

    try {
      t.assert.strictEqual(new PermissionConfig('/tmp/project').path, join(homedir(), '.pi', 'permissions.json'));
      await config.reload();
      t.assert.deepStrictEqual(config.getEffectiveRules(), []);
      await config.replaceRules('global', [{action: 'ask', command: 'gh'}]);
      await t.assert.rejects(config.replaceRules('global', [{action: 'other', command: 'gh'}]), /Invalid permission action/v);
      await t.assert.rejects(config.replaceRules('global', [{action: 'ask', command: '$CLI'}]), /Invalid permission command/v);
      await t.assert.rejects(config.replaceRules('global', [
        {action: 'ask', command: 'gh'},
        {action: 'deny', command: 'gh'},
      ]), /Duplicate permission command/v);

      await writeFile(path, JSON.stringify({commands: [], unknown: true}));
      await t.assert.rejects(config.reload(), /Unknown permission configuration field/v);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

void describe('permission decisions', () => {
  void test('applies longest selectors and action precedence across invocations', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
    const permissions = new Permissions({} as ExtensionAPI, config);

    try {
      await config.replaceRules('global', [
        {action: 'ask', command: 'gh'},
        {action: 'allow', command: 'gh repo view'},
        {action: 'stage', command: 'acli'},
        {action: 'deny', command: 'rm'},
      ]);

      t.assert.strictEqual(await permissions.check('gh repo view owner/repo', createContext('Deny')), undefined);
      t.assert.deepStrictEqual(await permissions.check('gh issue list', createContext('Deny')), {
        block: true,
        reason: 'Command blocked by user.',
      });
      t.assert.deepStrictEqual(await permissions.check('acli status && gh issue list', createContext('Deny')), {
        block: true,
        reason: 'Blocked for host staging: acli status && gh issue list\nMatched permission selector: acli. The user must review and press Enter to run it.',
        terminate: true,
      });
      t.assert.deepStrictEqual(await permissions.check('acli status && rm file', createContext('Allow once')), {
        block: true,
        reason: 'Denied by global command permission policy (rm).',
      });
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('remembers exact ask approvals, steers, and fails closed without UI', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
    const steeringMessages: Array<{message: string; deliverAs: string | undefined}> = [];
    const permissions = new Permissions({
      /** Records steering without starting an agent turn during the test. */
      sendUserMessage(message: string, options?: {deliverAs?: string}) {
        steeringMessages.push({message, deliverAs: options?.deliverAs});
      },
    } as never, config);

    try {
      await config.replaceRules('global', [{action: 'ask', command: 'helm'}]);
      t.assert.strictEqual(await permissions.check('helm list', createContext('Allow for this session')), undefined);
      t.assert.strictEqual(await permissions.check('helm list', createContext('Deny')), undefined);
      t.assert.deepStrictEqual(
        await permissions.check('helm uninstall app', createContext('Deny and steer…', true, ' inspect first ')),
        {block: true, reason: 'Command blocked by user.'},
      );
      t.assert.deepStrictEqual(steeringMessages, [{message: 'inspect first', deliverAs: 'steer'}]);
      t.assert.deepStrictEqual(await permissions.check('helm status app', createContext(undefined, false)), {
        block: true,
        reason: 'Command permission required for helm, but no confirmation UI is available.',
      });
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

void describe('/permissions command', () => {
  void test('adds scoped actions and shows effective settings', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
    const notifications: Array<{message: string; level: string}> = [];
    const menus: string[][] = [];
    const selections: Array<string | undefined> = ['+ Add a command permission', 'stage', undefined];
    const inputs = ['acli confluence', '-h; --help'];
    let handler: ((arguments_: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    new PermissionCommand(config).register({
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
        throw new Error('/permissions was not registered');
      }

      await config.replaceRules('global', [{action: 'deny', command: 'rm'}]);
      await handler('', ctx);
      await config.reload();
      t.assert.deepStrictEqual(config.getScopedRules('project'), [{
        action: 'stage',
        command: 'acli confluence',
        passthrough: ['-h', '--help'],
      }]);
      t.assert.ok(menus.at(-1)?.some(item => item.includes('acli confluence') && item.includes('stage')));
      t.assert.ok(menus.at(-1)?.some(item => item.includes('rm') && item.includes('deny')));

      await handler('other', ctx);
      t.assert.ok(notifications.some(item => item.level === 'error'));
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });
});

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

/** Captures extension handlers without giving permissions process-execution APIs. */
function createLifecycleHarness(permissions: Permissions): {
  busEvents: Map<string, (data: unknown) => void>;
  ctx: ExtensionContext;
  editor: () => string;
  events: Map<string, EventHandler>;
  messages: Array<{message: unknown; options: unknown}>;
  notifications: string[];
} {
  const busEvents = new Map<string, (data: unknown) => void>();
  const events = new Map<string, EventHandler>();
  const messages: Array<{message: unknown; options: unknown}> = [];
  const notifications: string[] = [];
  let editor = '';
  const pi = permissions.pi as unknown as {
    events: {on: (name: string, handler: (data: unknown) => void) => () => void};
    on: (name: string, handler: EventHandler) => void;
    registerCommand: () => void;
    sendMessage: (message: unknown, options: unknown) => void;
  };
  pi.events = {
    on(name, handler) {
      busEvents.set(name, handler);
      return () => {
        busEvents.delete(name);
      };
    },
  };
  pi.on = (name, handler) => {
    events.set(name, handler);
  };

  pi.registerCommand = () => undefined;

  pi.sendMessage = (message, options) => {
    messages.push({message, options});
  };

  permissions.register();

  const ctx = {
    hasUI: true,
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
    busEvents, ctx, editor: () => editor, events, messages, notifications,
  };
}

/** Builds the typed Bash event used by lifecycle checks. */
function bashEvent(command: string): ToolCallEvent {
  return {
    input: {command}, toolCallId: 'bash-1', toolName: 'bash', type: 'tool_call',
  };
}

void describe('staged permission lifecycle', () => {
  void test('stages without executing and continues after reviewed host completion', async (t: TestContext) => {
    const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
    const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
    const permissions = new Permissions({} as ExtensionAPI, config);

    try {
      await config.replaceRules('global', [{action: 'stage', command: 'acli'}]);
      const harness = createLifecycleHarness(permissions);
      const toolCall = harness.events.get('tool_call');
      const settled = harness.events.get('agent_settled');
      const userBash = harness.events.get('user_bash');
      const userBashEnd = harness.busEvents.get('sloppi:user-bash-end');
      if (toolCall === undefined || settled === undefined || userBash === undefined || userBashEnd === undefined) {
        throw new Error('Permission lifecycle handlers not registered');
      }

      const result = await toolCall(bashEvent('acli status') as never, harness.ctx) as ToolCallEventResult;
      t.assert.strictEqual(result.block, true);
      t.assert.strictEqual(result.terminate, true);
      t.assert.strictEqual(harness.editor(), '');
      settled({type: 'agent_settled'} as never, harness.ctx);
      t.assert.strictEqual(harness.editor(), '!acli status');
      t.assert.match(harness.notifications[0] ?? '', /press Enter only to run/v);

      userBash({command: 'acli status'} as never, harness.ctx);
      userBashEnd('acli status');
      t.assert.deepStrictEqual(harness.messages, [{
        message: {
          customType: 'permissions-stage-continue',
          content: 'The reviewed host command has finished. Continue working on the current task using its result.',
          display: false,
        },
        options: {triggerTurn: true},
      }]);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  void test('registers only the unified extension and keeps host execution APIs absent', async (t: TestContext) => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      pi: {extensions: string[]};
    };
    const implementation = await readFile(new URL('../agent/extensions/permissions/index.ts', import.meta.url), 'utf8');

    t.assert.ok(packageJson.pi.extensions.includes('./agent/extensions/permissions/index.ts'));
    t.assert.ok(packageJson.pi.extensions.every(extension => !extension.includes('/staging/')));
    t.assert.doesNotMatch(implementation, /child_process|createLocalBashOperations|execa|pi\.exec|\.abort\(/v);
  });
});
