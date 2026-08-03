import {describe, test, type TestContext} from 'node:test';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';
import networkAccess from '../agent/extensions/network-access.ts';

type RegisteredTool = {
  execute: (...arguments_: [
    id: string,
    input: {domain: string; method: string; path: string},
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ]) => Promise<{content: Array<{text: string}>}>;
};

void describe('network access', () => {
  void test('asks before granting normalized, temporary access', async (t: TestContext) => {
    let tool: RegisteredTool | undefined;
    const exec = t.mock.fn(async () => ({code: 0, stderr: '', stdout: 'Allowed api.example.com for 60 seconds'}));

    networkAccess({
      exec,
      registerTool(registeredTool: RegisteredTool) {
        tool = registeredTool;
      },
    } as unknown as ExtensionAPI);

    if (tool === undefined) {
      throw new Error('Network access tool was not registered');
    }

    const confirm = t.mock.fn(async () => true);
    const ctx = {hasUI: true, ui: {confirm}} as unknown as ExtensionContext;
    const result = await tool.execute(
      'call-1',
      {domain: 'API.Example.com.', method: 'post', path: '/v1/items'},
      undefined,
      undefined,
      ctx,
    );

    t.assert.strictEqual(confirm.mock.calls.length, 1);
    t.assert.deepStrictEqual(exec.mock.calls[0]?.arguments.slice(0, 2), [
      'sudo',
      ['-n', '/usr/local/sbin/sloppi-allow-request', 'POST', 'api.example.com', '/v1/items'],
    ]);
    t.assert.match(result.content[0]?.text ?? '', /60 seconds/v);
  });
});
