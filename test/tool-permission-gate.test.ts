import process from 'node:process';
import {
  afterEach,
  describe,
  test,
  type TestContext,
} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import toolPermissionGate from '../agent/extensions/tool-permission-gate.ts';

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | void>;

type RegisteredCommand = {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
};

const initialPiDev = process.env.PI_DEV;

afterEach(() => {
  if (initialPiDev === undefined) {
    delete process.env.PI_DEV;
  } else {
    process.env.PI_DEV = initialPiDev;
  }
});

function createBashToolCall(command: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName: 'bash',
    input: {command},
  };
}

function createContext(
  confirm: () => Promise<boolean>,
  hasUI = true,
): ExtensionContext {
  return {
    hasUI,
    ui: {
      confirm,
      notify() {
        return undefined;
      },
    },
  } as unknown as ExtensionContext;
}

function createGate() {
  let handler: unknown;
  const messages: unknown[] = [];
  const commands = new Map<string, unknown>();

  toolPermissionGate({
    on(event, registeredHandler) {
      if (event === 'tool_call') {
        handler = registeredHandler;
      }
    },
    sendMessage(message) {
      messages.push(message);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });

  return {
    handler: handler as ToolCallHandler,
    messages,
    getCommand(name: string): RegisteredCommand {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(`Command not found: ${name}`);
      }

      return command as RegisteredCommand;
    },
  };
}

void describe('tool-permission-gate', () => {
  void test('registers a tool_call handler', (t: TestContext) => {
    const {handler} = createGate();
    t.assert.strictEqual(typeof handler, 'function');
  });

  void test('allows ordinary commands and leaves sudo to its dedicated gate', async (t: TestContext) => {
    const confirm = t.mock.fn(async () => false);
    const {handler} = createGate();
    const ordinaryResult = await handler(
      createBashToolCall('echo hello'),
      createContext(confirm),
    );
    const sudoResult = await handler(
      createBashToolCall('sudo apt update'),
      createContext(confirm),
    );

    t.assert.strictEqual(ordinaryResult, undefined);
    t.assert.strictEqual(sudoResult, undefined);
    t.assert.strictEqual(confirm.mock.calls.length, 0);
  });

  void test('is disabled by default under pi-dev', async (t: TestContext) => {
    // eslint-disable-next-line node-test/no-process-env-mutation -- restored by afterEach.
    process.env.PI_DEV = 'true';

    const confirm = t.mock.fn(async () => false);
    const {handler} = createGate();
    const result = await handler(createBashToolCall('rm file.txt'), createContext(confirm));

    t.assert.strictEqual(result, undefined);
    t.assert.strictEqual(confirm.mock.calls.length, 0);
  });

  void test('/permissions turns risky command confirmation off and on', async (t: TestContext) => {
    const confirm = t.mock.fn(async () => false);
    const {handler, getCommand} = createGate();
    const context = createContext(confirm);

    await getCommand('permissions').handler('off', context);
    const disabledResult = await handler(createBashToolCall('rm file.txt'), context);

    await getCommand('permissions').handler('on', context);
    const enabledResult = await handler(createBashToolCall('rm file.txt'), context);

    t.assert.strictEqual(disabledResult, undefined);
    t.assert.deepStrictEqual(enabledResult, {
      block: true,
      reason: 'Blocked by extension approval gate',
    });
    t.assert.strictEqual(confirm.mock.calls.length, 1);
  });

  void test('blocks deletion in non-interactive mode', async (t: TestContext) => {
    const {handler} = createGate();
    const result = await handler(
      createBashToolCall('rm file.txt'),
      createContext(async () => true, false),
    );

    t.assert.deepStrictEqual(result, {
      block: true,
      reason: 'Blocked risky command in non-interactive mode',
    });
  });

  void test('blocks Node deletion after the user rejects rm and steers the model', async (t: TestContext) => {
    const confirm = t.mock.fn(async () => false);
    const {handler, messages} = createGate();
    const context = createContext(confirm);

    const denied = await handler(createBashToolCall('rm file.txt'), context);
    const bypass = await handler(
      createBashToolCall('node -e "require(\'node:fs\').unlinkSync(\'file.txt\')"'),
      context,
    );

    t.assert.deepStrictEqual(denied, {
      block: true,
      reason: 'Blocked by extension approval gate',
    });
    t.assert.deepStrictEqual(bypass, {
      block: true,
      reason:
        'File deletion remains denied for this session. Obtain explicit new user approval before retrying.',
    });
    t.assert.strictEqual(confirm.mock.calls.length, 1);
    t.assert.strictEqual(messages.length, 1);
  });
});
