import {describe, test, type TestContext} from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import sudoGate from '../agent/extensions/sudo-gate.ts';

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult | void>;

type RegisteredCommand = {
  handler: (args: string | undefined, ctx: ExtensionContext) => Promise<void>;
};

type Harness = {
  command: RegisteredCommand;
  ctx: ExtensionContext;
  handler: ToolCallHandler;
  messages: Array<{content: string}>;
  statuses: string[];
};

function createToolCall(
  toolName: string,
  input: Record<string, unknown>,
): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'tool-call-1',
    toolName,
    input,
  };
}

function createHarness(options: {
  confirm?: () => Promise<boolean>;
  hasUI?: boolean;
  select?: () => Promise<string | undefined>;
} = {}): Harness {
  let command: RegisteredCommand | undefined;
  let handler: ToolCallHandler | undefined;
  const messages: Array<{content: string}> = [];
  const statuses: string[] = [];

  sudoGate({
    on(event: string, registeredHandler: ToolCallHandler) {
      if (event === 'tool_call') {
        handler = registeredHandler;
      }
    },
    registerCommand(name: string, registeredCommand: RegisteredCommand) {
      if (name === 'sudo') {
        command = registeredCommand;
      }
    },
    sendMessage(message: {content: string}) {
      messages.push(message);
    },
  } as unknown as Parameters<typeof sudoGate>[0]);

  if (command === undefined || handler === undefined) {
    throw new Error('Sudo gate did not register its command and tool handler');
  }

  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: options.confirm ?? (async () => false),
      notify() {
        return undefined;
      },
      select: options.select ?? (async () => undefined),
      setStatus(_id: string, status: string) {
        statuses.push(status);
      },
      theme: {
        fg: (_token: string, content: string) => content,
      },
    },
  } as unknown as ExtensionContext;

  return {
    command,
    ctx,
    handler,
    messages,
    statuses,
  };
}

void describe('sudo-gate', () => {
  void test('denies sudo by default and tells the agent to try another approach', async (t: TestContext) => {
    const harness = createHarness();
    const result = await harness.handler(
      createToolCall('bash', {command: 'sudo apt update'}),
      harness.ctx,
    );

    t.assert.strictEqual(result?.block, true);
    t.assert.match(result?.reason ?? '', /Sudo is not allowed by default/v);
    t.assert.match(harness.messages[0]?.content ?? '', /Try another approach/v);
  });

  void test('checks every tool input and ignores partial words', async (t: TestContext) => {
    const harness = createHarness();
    const writeResult = await harness.handler(
      createToolCall('write', {content: 'sudo reboot', path: 'script.sh'}),
      harness.ctx,
    );
    const ordinaryResult = await harness.handler(
      createToolCall('bash', {command: 'echo pseudonym'}),
      harness.ctx,
    );

    t.assert.strictEqual(writeResult?.block, true);
    t.assert.strictEqual(ordinaryResult, undefined);
  });

  void test('ask mode allows one approved call and denies a rejected call', async (t: TestContext) => {
    let confirmationCount = 0;
    const confirm = t.mock.fn(async () => {
      confirmationCount += 1;
      return confirmationCount === 1;
    });
    const harness = createHarness({confirm});
    await harness.command.handler('ask', harness.ctx);

    const allowed = await harness.handler(
      createToolCall('bash', {command: 'sudo apt update'}),
      harness.ctx,
    );
    const denied = await harness.handler(
      createToolCall('bash', {command: 'sudo apt upgrade'}),
      harness.ctx,
    );

    t.assert.strictEqual(allowed, undefined);
    t.assert.strictEqual(denied?.block, true);
    t.assert.strictEqual(confirm.mock.calls.length, 2);
  });

  void test('ask mode fails closed without UI', async (t: TestContext) => {
    const harness = createHarness({hasUI: false});
    await harness.command.handler('ask', harness.ctx);

    const result = await harness.handler(
      createToolCall('bash', {command: 'sudo apt update'}),
      harness.ctx,
    );

    t.assert.strictEqual(result?.block, true);
  });

  void test('allow mode permits sudo without confirmation', async (t: TestContext) => {
    const confirm = t.mock.fn(async () => false);
    const harness = createHarness({confirm});
    await harness.command.handler('allow', harness.ctx);

    const result = await harness.handler(
      createToolCall('bash', {command: 'sudo apt update'}),
      harness.ctx,
    );

    t.assert.strictEqual(result, undefined);
    t.assert.strictEqual(confirm.mock.calls.length, 0);
  });

  void test('/sudo changes mode through the UI and updates its footer status', async (t: TestContext) => {
    const harness = createHarness({select: async () => 'allow'});
    await harness.command.handler(undefined, harness.ctx);

    t.assert.deepStrictEqual(harness.statuses, ['sudo: allowed']);
    const result = await harness.handler(
      createToolCall('bash', {command: 'sudo apt update'}),
      harness.ctx,
    );
    t.assert.strictEqual(result, undefined);
  });
});
