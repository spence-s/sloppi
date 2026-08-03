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
  void test('offers one-shot and permanent access for a normalized request', async (t: TestContext) => {
    let tool: RegisteredTool | undefined;
    const exec = t.mock.fn(async () => ({code: 0, stderr: '', stdout: 'Always allowed POST api.example.com/v1/items'}));

    networkAccess({
      exec,
      registerTool(registeredTool: RegisteredTool) {
        tool = registeredTool;
      },
    } as unknown as ExtensionAPI);

    if (tool === undefined) {
      throw new Error('Network access tool was not registered');
    }

    let choice = 'Deny';
    const select = t.mock.fn(async (_title: string, _choices: string[]) => choice);
    const ctx = {hasUI: true, ui: {select}} as unknown as ExtensionContext;
    const input = {domain: 'API.Example.com.', method: 'post', path: '/v1/items'};
    const denied = await tool.execute('call-1', input, undefined, undefined, ctx);

    t.assert.match(denied.content[0]?.text ?? '', /denied/v);
    t.assert.strictEqual(exec.mock.calls.length, 0);

    choice = 'Always allow POST api.example.com/v1/items';
    const result = await tool.execute('call-2', input, undefined, undefined, ctx);

    t.assert.deepStrictEqual(select.mock.calls[0]?.arguments[1], [
      'Allow POST api.example.com/v1/items once',
      'Always allow POST api.example.com/v1/items',
      'Always allow all requests to api.example.com',
      'Deny',
    ]);
    t.assert.deepStrictEqual(exec.mock.calls[0]?.arguments.slice(0, 2), [
      'sudo',
      ['-n', '/usr/local/sbin/sloppi-allow-request', 'request', 'POST', 'api.example.com', '/v1/items'],
    ]);
    t.assert.match(result.content[0]?.text ?? '', /Always allowed POST/v);
  });
});
