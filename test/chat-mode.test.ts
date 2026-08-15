import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import chatMode, {onToolCall} from '../agent/extensions/chat-mode.ts';

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

type ChatModeHarness = {
  ctx: ExtensionContext;
  getActiveTools: () => string[];
  getCommand: (name: string) => RegisteredCommand;
  getBeforeAgentStart: () => () => Promise<BeforeAgentStartResult>;
  getSentMessages: () => Array<{activeTools: string[]; text: string}>;
  getStatus: () => string | undefined;
};

function createHarness(initialTools: string[]): ChatModeHarness {
  let activeTools = [...initialTools];
  let status: string | undefined;
  const sentMessages: Array<{activeTools: string[]; text: string}> = [];
  const commands = new Map<string, RegisteredCommand>();
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();

  chatMode({
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
    sendUserMessage(text: string) {
      sentMessages.push({activeTools: [...activeTools], text});
    },
  } as unknown as Parameters<typeof chatMode>[0]);

  const ctx = {
    ui: {
      theme: {
        fg: (token: string, content: string) => `[${token}]${content}`,
      },
      setStatus(_key: string, value: string | undefined) {
        status = value;
      },
      notify() {
        return undefined;
      },
    },
    sessionManager: {
      getBranch: () => [],
    },
    isIdle: () => true,
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
    getSentMessages: () => [...sentMessages],
    getStatus: () => status,
  };
}

void describe('chat-mode', () => {
  void test('registers /chat command and tool/session handlers', (t: TestContext) => {
    const commands: string[] = [];
    const events: string[] = [];

    chatMode({
      registerCommand(name: string) {
        commands.push(name);
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as Parameters<typeof chatMode>[0]);

    t.assert.deepStrictEqual(commands, ['chat']);
    t.assert.deepStrictEqual(events, [
      'before_agent_start',
      'tool_call',
      'session_start',
      'session_tree',
    ]);
  });

  void test('onToolCall allows tools when chat mode is disabled', (t: TestContext) => {
    const result = onToolCall(createToolCall('read'), false);
    t.assert.strictEqual(result, undefined);
  });

  void test('onToolCall allows file and web research when chat mode is enabled', (t: TestContext) => {
    t.assert.deepStrictEqual(
      ['read', 'grep', 'web_search', 'source_check', 'fetch_content', 'get_search_content']
        .map(tool => onToolCall(createToolCall(tool), true)),
      [undefined, undefined, undefined, undefined, undefined, undefined],
    );
  });

  void test('onToolCall blocks non-read tools when chat mode is enabled', (t: TestContext) => {
    const result = onToolCall(createToolCall('bash'), true);

    t.assert.deepStrictEqual(result, {
      block: true,
      reason:
        'Chat mode is enabled: only read-only tools and web research are allowed. Use /chat off to re-enable full tool access.',
    });
  });

  void test('chat on restricts active tools to reads and searches and sets enabled LLM context', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('chat').handler('on', harness.ctx);

    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'grep',
      'find',
      'ls',
      'web_search',
      'source_check',
      'fetch_content',
      'get_search_content',
    ]);
    t.assert.strictEqual(harness.getStatus(), '[dim]󰒓 [text]chat');

    const beforeAgentStartResult = await harness.getBeforeAgentStart()();
    t.assert.strictEqual(
      beforeAgentStartResult.message.content,
      'Chat mode is active. You may use read-only tools and web research. Do not call bash, edit, or write.',
    );
  });

  void test('chat off restores tools and sets agent-mode LLM context', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('chat').handler('on', harness.ctx);
    await harness.getCommand('chat').handler('off', harness.ctx);

    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'bash',
      'edit',
      'write',
    ]);
    t.assert.strictEqual(harness.getStatus(), '[dim]󰒓 [text]agent');

    const beforeAgentStartResult = await harness.getBeforeAgentStart()();
    t.assert.strictEqual(
      beforeAgentStartResult.message.content,
      'Agent mode is active. You may call available tools normally, including bash, edit, write, or other tools.',
    );
  });

  void test('chat toggle flips between chat and agent tool policies', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('chat').handler('toggle', harness.ctx);
    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'grep',
      'find',
      'ls',
      'web_search',
      'source_check',
      'fetch_content',
      'get_search_content',
    ]);

    await harness.getCommand('chat').handler('toggle', harness.ctx);
    t.assert.deepStrictEqual(harness.getActiveTools(), [
      'read',
      'bash',
      'edit',
      'write',
    ]);
  });

  void test('chat with a prompt enables chat mode before submitting it', async (t: TestContext) => {
    const harness = createHarness(['read', 'bash', 'edit', 'write']);

    await harness.getCommand('chat').handler('Explain this code', harness.ctx);

    t.assert.deepStrictEqual(harness.getSentMessages(), [{
      activeTools: [
        'read',
        'grep',
        'find',
        'ls',
        'web_search',
        'source_check',
        'fetch_content',
        'get_search_content',
      ],
      text: 'Explain this code',
    }]);
    t.assert.strictEqual(harness.getStatus(), '[dim]󰒓 [text]chat');
  });
});
