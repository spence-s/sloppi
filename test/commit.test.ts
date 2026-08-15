import {test, type TestContext} from 'node:test';
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import commit from '../agent/extensions/commit.ts';

void test('loads an editable, safely quoted commit command without running it', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  let handler: Handler | undefined;
  let editorText = '';

  commit({
    async exec(_command: string, arguments_: string[]) {
      if (arguments_[0] === 'rev-parse') {
        return {code: 0, stderr: '', stdout: '/repo\n'};
      }

      if (arguments_[0] === 'status') {
        return {code: 0, stderr: '', stdout: ' M agent/extensions/commit.ts\n'};
      }

      if (arguments_.includes('add')) {
        return {code: 0, stderr: '', stdout: ''};
      }

      if (arguments_[0] === 'diff') {
        return {code: 0, stderr: '', stdout: 'diff --git a/file b/file\n+secure change\n'};
      }

      throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`);
    },
    registerCommand(name: string, options: {handler: Handler}) {
      t.assert.strictEqual(name, 'commit');
      handler = options.handler;
    },
  } as unknown as Parameters<typeof commit>[0]);

  const ctx = {
    cwd: '/repo/subdirectory',
    isProjectTrusted: () => true,
    mode: 'tui',
    model: {id: 'test-model', provider: 'test-provider'},
    modelRegistry: {
      async complete(_model: unknown, prompt: {messages: Array<{content: Array<{text: string}>}>}) {
        t.assert.match(prompt.messages[0]?.content[0]?.text ?? '', /secure change/v);
        return {
          content: [{type: 'text', text: 'feat(commit): improve command\'s safety'}],
          stopReason: 'stop',
        };
      },
    },
    ui: {
      notify() {
        return undefined;
      },
      setEditorText(text: string) {
        editorText = text;
      },
    },
    waitForIdle: async () => undefined,
  } as unknown as ExtensionCommandContext;

  await handler?.('', ctx);

  t.assert.strictEqual(
    editorText,
    '!git commit -m \'feat(commit): improve command\'"\'"\'s safety\'',
  );
});
