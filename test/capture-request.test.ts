/* eslint-disable no-await-in-loop, node-test/no-conditional-assertion -- Fixed provider fixtures deliberately exercise the same one-shot state sequentially. */
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent';
import captureRequest from '../agent/extensions/capture-request.ts';

/**
 Exercises the registered command and request hook against real files, rather
 than exporting report internals. Fixtures cover the three common provider
 shapes, private output, hostile content, one-shot behavior, and write failure.
 */
void test('capture request writes private offline reports without changing requests', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'capture-request-test-'));
  let command: RegisteredCommand | undefined;
  let hook: ((event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown) | undefined;
  const notifications: string[] = [];
  const pi = {
    /**
     Retains the public command registration so the integration uses the same
     arming path as a user's slash command.
     */
    registerCommand(_name: string, registered: RegisteredCommand) {
      command = registered;
    },
    /**
     Retains the request hook so provider fixtures pass through the extension's
     real capture flow, including its filesystem boundary.
     */
    on(_name: string, handler: typeof hook) {
      hook = handler;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    model: {
      provider: 'fixture', id: 'fixture-model', api: 'fixture-api',
      cost: {
        input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 8,
      },
      contextWindow: 100_000, maxTokens: 4000,
    },
    ui: {
      /**
       Collects notifications without a terminal, including the failure path
       that must not stop the underlying model request.
       */
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;

  try {
    captureRequest(pi);
    assert.ok(command);
    assert.ok(hook);
    await hook({type: 'before_provider_request', payload: {}}, ctx);
    assert.deepEqual(await readdir(cwd), []);

    const instructions = '# Guidance\n你好 🍜 <script>alert(1)</script>\n## Tools\nBe careful.';
    const fixtures = [
      {instructions, input: [{role: 'user', content: 'hello'}], tools: [{name: 'read', parameters: {type: 'object'}}]},
      {system: [{type: 'text', text: instructions}], messages: [{role: 'user', content: 'hello'}], tools: [{name: 'read', input_schema: {type: 'object'}}]},
      {messages: [{role: 'developer', content: instructions}, {role: 'user', content: 'hello'}], tools: [{type: 'function', function: {name: 'read'}}]},
      {systemInstruction: {parts: [{text: instructions}]}, contents: [{role: 'user', parts: [{text: 'hello'}]}], tools: [{functionDeclarations: [{name: 'read'}]}]},
    ];
    for (const payload of fixtures) {
      const before = JSON.stringify(payload);
      const previous = new Set(await readdir(cwd));
      await command.handler('', ctx);
      await hook({type: 'before_provider_request', payload}, ctx);
      assert.equal(JSON.stringify(payload), before);
      const current = await readdir(cwd);
      const added = current.filter(name => !previous.has(name));
      assert.equal(added.length, 1);
      const directory = path.join(cwd, added[0]!);
      const directoryStat = await stat(directory);
      assert.equal(directoryStat.mode % 0o1000, 0o700);
      for (const file of await readdir(directory)) {
        const fileStat = await stat(path.join(directory, file));
        assert.equal(fileStat.mode % 0o1000, 0o600);
      }

      const captured = await readFile(path.join(directory, 'latest-request.json'), 'utf8');
      assert.deepEqual(JSON.parse(captured), payload);
      const report = await readFile(path.join(directory, 'context-report.html'), 'utf8');
      assert.ok(report.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
      assert.ok(!report.includes('<script>'));
      assert.ok(report.includes('default-src \'none\''));
      assert.ok(report.includes('Instruction sections'));
      assert.ok(report.includes('## Tools'));
      assert.ok(report.includes('fixture-model'));
      assert.ok(report.includes('cache read 0.2'));
      assert.ok(report.includes('Conversation'));
      assert.ok(report.includes('read'));
      const capturedInstructions = await readFile(path.join(directory, 'last-instructions.txt'), 'utf8');
      assert.ok(capturedInstructions.includes('# Guidance'));
      await hook({type: 'before_provider_request', payload}, ctx);
      const afterRetry = await readdir(cwd);
      assert.equal(afterRetry.length, previous.size + 1);
    }

    const previous = new Set(await readdir(cwd));
    await command.handler('', ctx);
    await hook({type: 'before_provider_request', payload: {instructions: 'abcd'}}, ctx);
    const current = await readdir(cwd);
    const pricingDirectory = current.find(name => !previous.has(name));
    assert.notEqual(pricingDirectory, undefined);
    const pricingReport = await readFile(path.join(cwd, pricingDirectory!, 'context-report.html'), 'utf8');
    assert.ok(pricingReport.includes('~1 tokens'));
    assert.ok(pricingReport.includes('$0.000002 uncached / request'));
    assert.ok(pricingReport.includes('<strong>Instructions</strong>: 6 bytes'));

    await command.handler('', ctx);
    await hook({type: 'before_provider_request', payload: {instructions: 'abcd'}}, {...ctx, model: undefined, cwd: path.join(cwd, 'missing')});
    assert.ok(notifications.at(-1)?.includes('Request capture failed:'));
    await hook({type: 'before_provider_request', payload: {}}, ctx);
    const afterFailure = await readdir(cwd);
    assert.equal(afterFailure.length, fixtures.length + 1);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});
