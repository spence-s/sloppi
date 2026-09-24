import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import commit from '../agent/extensions/commit.ts';

void test('uses the selected commit model outside the session scope and loads a safely quoted command', async (t: TestContext) => {
  type Handler = (arguments_: string, ctx: ExtensionCommandContext) => Promise<void>;
  type CommandOptions = Parameters<Parameters<typeof commit>[0]['registerCommand']>[1];
  let getArgumentCompletions: NonNullable<CommandOptions['getArgumentCompletions']> | undefined;
  let handler: Handler | undefined;
  let editorText = '';
  let diffArguments: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-commit-'));
  t.after(async () => rm(directory, {recursive: true}));
  const sessionModel = {id: 'session-model', provider: 'test-provider'};
  const commitModel = {id: 'commit-model', provider: 'test-provider'};

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

      if (arguments_[0] === 'diff' && arguments_.includes('--stat')) {
        return {code: 0, stderr: '', stdout: ' file | 1 +\n 1 file changed, 1 insertion(+)\n'};
      }

      if (arguments_[0] === 'diff') {
        diffArguments = arguments_;
        return {code: 0, stderr: '', stdout: 'diff --git a/file b/file\n+secure change\n'};
      }

      throw new Error(`Unexpected Git command: ${arguments_.join(' ')}`);
    },
    registerCommand(name: string, options: CommandOptions) {
      t.assert.strictEqual(name, 'commit');
      getArgumentCompletions = options.getArgumentCompletions;
      handler = options.handler;
    },
  } as unknown as Parameters<typeof commit>[0], join(directory, 'model.json'));

  const ctx = {
    cwd: '/repo/subdirectory',
    isProjectTrusted: () => true,
    mode: 'tui',
    model: sessionModel,
    modelRegistry: {
      async complete(model: unknown, prompt: {messages: Array<{content: Array<{text: string}>}>}) {
        t.assert.deepStrictEqual(model, commitModel);
        const modelInput = prompt.messages[0]?.content[0]?.text ?? '';
        t.assert.match(modelInput, /1 file changed/v);
        t.assert.match(modelInput, /secure change/v);
        return {
          content: [{type: 'text', text: 'feat(commit): improve command\'s safety'}],
          stopReason: 'stop',
        };
      },
      find: (provider: string, id: string) =>
        provider === commitModel.provider && id === commitModel.id ? commitModel : undefined,
      getAvailable: () => [sessionModel, commitModel],
    },
    scopedModels: [{model: sessionModel}],
    ui: {
      notify() {
        return undefined;
      },
      select: async () => `${commitModel.provider}/${commitModel.id}`,
      setEditorText(text: string) {
        editorText = text;
      },
    },
    waitForIdle: async () => undefined,
  } as unknown as ExtensionCommandContext;

  t.assert.deepStrictEqual(await getArgumentCompletions?.('m'), [{
    value: 'model', label: 'model', description: 'Choose the commit model',
  }]);
  t.assert.strictEqual(await getArgumentCompletions?.('other'), null);

  await handler?.('model', ctx);
  await handler?.('', ctx);

  t.assert.ok(diffArguments.includes(':(exclude,glob)**/package-lock.json'));
  t.assert.ok(diffArguments.includes(':(exclude,glob)**/*.snap'));
  t.assert.strictEqual(
    editorText,
    '!git commit -m \'feat(commit): improve command\'"\'"\'s safety\'',
  );
});
