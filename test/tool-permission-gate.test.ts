import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import toolPermissionGate, {
  classifyDanger,
  onToolCall,
} from '../agent/extensions/tool-permission-gate.ts';

function createBashToolCall(command: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName: 'bash',
    input: {command},
  };
}

function createContext(options: {
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
}): ExtensionContext {
  return {
    hasUI: options.hasUI,
    ui: {
      confirm: options.confirm,
    },
  } as unknown as ExtensionContext;
}

void describe('tool-permission-gate', () => {
  void test('registers a tool_call handler', (t: TestContext) => {
    let eventName: string | undefined;
    let handler: unknown;

    toolPermissionGate({
      on(event, registeredHandler) {
        eventName = event;
        handler = registeredHandler;
      },
    });

    t.assert.strictEqual(eventName, 'tool_call');
    t.assert.strictEqual(typeof handler, 'function');
  });

  void test('classifyDanger returns empty for non-dangerous command', (t: TestContext) => {
    t.assert.deepStrictEqual(classifyDanger('echo hello'), []);
  });

  void test('classifyDanger flags sudo + recursive rm + sensitive target', (t: TestContext) => {
    t.assert.deepStrictEqual(classifyDanger('sudo rm -rf /'), [
      'uses sudo',
      'uses recursive/force rm flags',
      'rm target looks sensitive (/)',
    ]);
  });

  void test('blocks dangerous bash command in non-interactive mode', async (t: TestContext) => {
    const result = await onToolCall(
      createBashToolCall('rm -rf /'),
      createContext({
        hasUI: false,
        confirm: async () => true,
      }),
    );

    t.assert.deepStrictEqual(result, {
      block: true,
      reason:
        'Blocked risky command in non-interactive mode: uses recursive/force rm flags; rm target looks sensitive (/)',
    });
  });

  void test('prompts and blocks when user denies in interactive mode', async (t: TestContext) => {
    const confirmMock = t.mock.fn(async () => false);

    const result = await onToolCall(
      createBashToolCall('rm -rf /etc'),
      createContext({
        hasUI: true,
        confirm: confirmMock,
      }),
    );

    t.assert.strictEqual(confirmMock.mock.calls.length, 1);
    t.assert.deepStrictEqual(result, {
      block: true,
      reason: 'Blocked by extension approval gate',
    });
  });

  void test('allows dangerous command when user confirms', async (t: TestContext) => {
    const confirmMock = t.mock.fn(async () => true);

    const result = await onToolCall(
      createBashToolCall('rm -rf /tmp/project-cache'),
      createContext({
        hasUI: true,
        confirm: confirmMock,
      }),
    );

    t.assert.strictEqual(confirmMock.mock.calls.length, 1);
    t.assert.strictEqual(result, undefined);
  });
});
