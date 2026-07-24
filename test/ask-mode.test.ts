import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import askMode, {onToolCall} from '../agent/extensions/ask-mode.ts';

function createToolCall(toolName: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName,
    input: {},
  };
}

type RegisteredCommand = {
  description: string;
  handler: (args: string | undefined, ctx: ExtensionContext) => Promise<void>;
};

type BeforeAgentStartResult = {
  message: {
    customType: string;
    content: string;
    display: boolean;
  };
};

type AskModeHarness = {
  ctx: ExtensionContext;
  getActiveTools: () => string[];
  getCommand: (name: string) => RegisteredCommand;
  getBeforeAgentStart: () => () => Promise<BeforeAgentStartResult>;
};

function createHarness(initialTools: string[]): AskModeHarness {
  let activeTools = [...initialTools];
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();

  askMode({
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      eventHandlers.set(event, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    appendEntry() {
      return undefined;
    },
  } as unknown as Parameters<typeof askMode>[0]);

  const ctx = {
    ui: {
      theme: {
        fg: (_token: string, content: string) => content,
      },
      setStatus() {
        return undefined;
      },
      notify() {
        return undefined;
      },
    },
    sessionManager: {
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    getActiveTools: () => [...activeTools],
    getCommand(name: string): RegisteredCommand {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(`Command not found: ${name}`);
      }

      return command;
    },
    getBeforeAgentStart(): () => Promise<BeforeAgentStartResult> {
      const handler = eventHandlers.get('before_agent_start');
      if (handler === undefined) {
        throw new Error('before_agent_start handler not found');
      }

      return handler as () => Promise<BeforeAgentStartResult>;
    },
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

  void test('onToolCall allows reads and searches when ask mode is enabled', (t: TestContext) => {
    t.assert.strictEqual(onToolCall(createToolCall('read'), true), undefined);
    t.assert.strictEqual(onToolCall(createToolCall('rg'), true), undefined);
  });

  void test('onToolCall blocks non-read tools when ask mode is enabled', (t: TestContext) => {
    const result = onToolCall(createToolCall('bash'), true);

    t.assert.deepStrictEqual(result, {
      block: true,
      reason:
        'Ask mode is enabled: only file reads and searches are allowed. Use /ask off to re-enable full tool access.',
    });
  });

  void test('ask on restricts active tools to read and rg and sets enabled LLM context', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('ask').handler('on', harness.ctx);

    t.assert.deepStrictEqual(harness.getActiveTools(), ['read', 'rg']);

    const beforeAgentStartResult = await harness.getBeforeAgentStart()();
    t.assert.strictEqual(
      beforeAgentStartResult.message.content,
      'Ask mode is active. You may only use the read and rg tools. Do not call bash, edit, write, or other tools.',
    );
  });

  void test('ask off restores tools and sets disabled LLM context', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('ask').handler('on', harness.ctx);
    await harness.getCommand('ask').handler('off', harness.ctx);

    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'bash',
      'edit',
      'write',
    ]);

    const beforeAgentStartResult = await harness.getBeforeAgentStart()();
    t.assert.strictEqual(
      beforeAgentStartResult.message.content,
      'Ask mode is inactive. You may call available tools normally.',
    );
  });

  void test('ask toggle flips between enabled and disabled tool policies', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('ask').handler('toggle', harness.ctx);
    t.assert.deepStrictEqual(harness.getActiveTools(), ['read', 'rg']);

    await harness.getCommand('ask').handler('toggle', harness.ctx);
    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'bash',
      'edit',
      'write',
    ]);
  });
});
