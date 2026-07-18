import {test, type TestContext} from 'node:test';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import planMode from '../agent/extensions/plan-mode.ts';

type RegisteredCommand = {
  handler: (args: string | undefined, ctx: ExtensionContext) => void;
};

type BeforeAgentStart = (event: {
  systemPrompt: string;
}) => {systemPrompt: string} | undefined;

function createHarness(initialTools: string[]) {
  let activeTools = [...initialTools];
  let command: RegisteredCommand | undefined;
  let beforeAgentStart: BeforeAgentStart | undefined;

  planMode({
    getActiveTools: () => [...activeTools],
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    registerCommand(_name: string, registered: RegisteredCommand) {
      command = registered;
    },
    on(event: string, handler: BeforeAgentStart) {
      if (event === 'before_agent_start') {
        beforeAgentStart = handler;
      }
    },
  } as unknown as Parameters<typeof planMode>[0]);

  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    ui: {
      theme: {
        fg: (_token: string, content: string) => content,
      },
      setStatus(id: string, status: string | undefined) {
        statuses.push([id, status]);
      },
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    getStatuses: () => [...statuses],
    getActiveTools: () => [...activeTools],
    getCommand() {
      if (command === undefined) {
        throw new Error('plan command not registered');
      }

      return command;
    },
    getBeforeAgentStart() {
      if (beforeAgentStart === undefined) {
        throw new Error('before_agent_start not registered');
      }

      return beforeAgentStart;
    },
  };
}

void test('plan mode restricts tools, adds planning prompt, then restores tools', (t: TestContext) => {
  const harness = createHarness(['read', 'bash', 'edit', 'write']);

  harness.getCommand().handler(undefined, harness.ctx);
  t.assert.deepStrictEqual(harness.getActiveTools(), [
    'read',
    'grep',
    'find',
    'ls',
    'rg',
  ]);
  t.assert.deepStrictEqual(harness.getStatuses(), [
    ['0:plan-mode', '📝 plan mode'],
  ]);
  t.assert.match(
    harness.getBeforeAgentStart()({systemPrompt: 'Base prompt'})
      ?.systemPrompt ?? '',
    /Plan mode active/v,
  );

  harness.getCommand().handler(undefined, harness.ctx);
  t.assert.deepStrictEqual(harness.getActiveTools(), [
    'read',
    'bash',
    'edit',
    'write',
  ]);
  t.assert.strictEqual(
    harness.getBeforeAgentStart()({systemPrompt: 'Base prompt'}),
    undefined,
  );
  t.assert.deepStrictEqual(harness.getStatuses(), [
    ['0:plan-mode', '📝 plan mode'],
    ['0:plan-mode', undefined],
  ]);
});
