import {describe, test, type TestContext} from 'node:test';
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
    ui: {confirm},
  } as unknown as ExtensionContext;
}

function createGate() {
  let handler: unknown;
  const messages: unknown[] = [];

  toolPermissionGate({
    on(event, registeredHandler) {
      if (event === 'tool_call') {
        handler = registeredHandler;
      }
    },
    sendMessage(message) {
      messages.push(message);
    },
  });

  return {handler: handler as ToolCallHandler, messages};
}

void describe('tool-permission-gate', () => {
  void test('registers a tool_call handler', (t: TestContext) => {
    const {handler} = createGate();
    t.assert.strictEqual(typeof handler, 'function');
  });

  void test('allows ordinary commands', async (t: TestContext) => {
    const {handler} = createGate();
    const result = await handler(
      createBashToolCall('echo hello'),
      createContext(async () => false),
    );
    t.assert.strictEqual(result, undefined);
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
      createBashToolCall(
        "node -e \"require('node:fs').unlinkSync('file.txt')\"",
      ),
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
