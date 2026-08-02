import {describe, test, type TestContext} from 'node:test';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import statusLine, {getOsLabel, parseGitStatus} from '../agent/extensions/status-line.ts';

void describe('status line', () => {
  void test('labels the host operating system', (t: TestContext) => {
    t.assert.strictEqual(getOsLabel('darwin'), ' macOS');
    t.assert.strictEqual(getOsLabel('linux'), ' Ubuntu');
  });

  void test('counts staged, modified, and untracked files', (t: TestContext) => {
    t.assert.deepStrictEqual(
      parseGitStatus('M  staged.ts\n M modified.ts\nMM both.ts\n?? new.ts\n'),
      {staged: 2, modified: 2, untracked: 1},
    );
  });

  void test('adds to the default footer instead of replacing it', async (t: TestContext) => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    let sessionStart: Handler | undefined;
    let statusId: string | undefined;
    let status: string | undefined;

    statusLine({
      async exec() {
        return {code: 0, stdout: ' M modified.ts\n'};
      },
      on(event: string, handler: Handler) {
        if (event === 'session_start') {
          sessionStart = handler;
        }
      },
    } as unknown as Parameters<typeof statusLine>[0]);

    const ctx = {
      cwd: '/repo',
      mode: 'tui',
      ui: {
        theme: {fg: (_token: string, text: string) => text},
        setStatus(id: string, text: string | undefined) {
          statusId = id;
          status = text;
        },
      },
    } as unknown as ExtensionContext;

    await sessionStart?.({}, ctx);
    t.assert.strictEqual(statusId, '0:0-status-line');
    t.assert.match(status ?? '', /(?:macOS|Ubuntu).*~1 \|$/v);
  });
});
