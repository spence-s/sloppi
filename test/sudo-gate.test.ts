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

  void test('allows sudo text outside bash tool calls', async (t: TestContext) => {
    const harness = createHarness();
    const readResult = await harness.handler(
      createToolCall('read', {path: 'agent/extensions/sudo-gate.ts'}),
      harness.ctx,
    );
    const writeResult = await harness.handler(
      createToolCall('write', {content: 'sudo reboot', path: 'script.sh'}),
      harness.ctx,
    );

    t.assert.strictEqual(readResult, undefined);
    t.assert.strictEqual(writeResult, undefined);
  });

  void test('allows harmless sudo text in bash arguments and file names', async (t: TestContext) => {
    const harness = createHarness();
    const commands = [
      'rg sudo .',
      'rg "sudo apt" test',
      'grep sudo README.md',
      'echo sudo',
      String.raw`printf "%s\n" sudo`,
      'git diff -- test/sudo-gate.test.ts',
      'ls agent/extensions/sudo-gate.ts',
      'cat /tmp/sudo',
      'touch feature-sudo-support.md',
      'echo pseudonym sudoers',
      'echo $sudo',
      'WORD=sudo rg "$WORD" .',
    ];

    const results = await Promise.all(commands.map(async command =>
      harness.handler(createToolCall('bash', {command}), harness.ctx)));

    t.assert.deepStrictEqual(results, commands.map(() => undefined));
  });

  void test('blocks sudo in direct and nested shell command positions', async (t: TestContext) => {
    const harness = createHarness();
    const commands = [
      'sudo',
      ' sudo apt update',
      '\tsudo -n true',
      'echo ready && sudo apt update',
      'false||sudo apt update',
      'echo ready;sudo apt update',
      'echo ready\nsudo apt update',
      'echo data | sudo tee /root/data',
      'sudo apt update & echo waiting',
      '(sudo apt update)',
      '{ sudo apt update; }',
      'echo $(sudo whoami)',
      'echo `sudo whoami`',
    ];

    const results = await Promise.all(commands.map(async command =>
      harness.handler(createToolCall('bash', {command}), harness.ctx)));

    t.assert.deepStrictEqual(results.map(result => result?.block), commands.map(() => true));
  });

  void test('blocks path-based sudo executables', async (t: TestContext) => {
    const harness = createHarness();
    const commands = [
      '/usr/bin/sudo apt update',
      '/usr/local/bin/sudo apt update',
      './sudo apt update',
      '../bin/sudo apt update',
      'echo ready && /usr/bin/sudo apt update',
    ];

    const results = await Promise.all(commands.map(async command =>
      harness.handler(createToolCall('bash', {command}), harness.ctx)));

    t.assert.deepStrictEqual(results.map(result => result?.block), commands.map(() => true));
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
