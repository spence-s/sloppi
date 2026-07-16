import {describe, test, type TestContext} from 'node:test';
import type {ToolCallEvent} from '@earendil-works/pi-coding-agent';
import askMode, {onToolCall} from '../agent/extensions/ask-mode.ts';

function createToolCall(toolName: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName,
    input: {},
  };
}

void describe('ask-mode', () => {
  void test('registers /ask command and tool/session handlers', (t: TestContext) => {
    const commands: string[] = [];
    const events: string[] = [];

    askMode({
      registerCommand(name: string) {
        commands.push(name);
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as Parameters<typeof askMode>[0]);

    t.assert.deepStrictEqual(commands, ['ask']);
    t.assert.deepStrictEqual(events, [
      'before_agent_start',
      'tool_call',
      'session_start',
      'session_tree',
    ]);
  });

  void test('onToolCall allows tools when ask mode is disabled', (t: TestContext) => {
    const result = onToolCall(createToolCall('read'), false);
    t.assert.strictEqual(result, undefined);
  });

  void test('onToolCall blocks all tools when ask mode is enabled', (t: TestContext) => {
    const result = onToolCall(createToolCall('bash'), true);

    t.assert.deepStrictEqual(result, {
      block: true,
      reason:
        'Ask mode is enabled: tool calls are disabled. Use /ask off to re-enable tools.',
    });
  });
});
