import {describe, test, type TestContext} from 'node:test';
import {initTheme, type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {visibleWidth} from '@earendil-works/pi-tui';
import shellUi, {parseGitStatus} from '../agent/extensions/shell-ui.ts';

void describe('shell UI', () => {
  void test('parses Powerlevel10k Git status fields', (t: TestContext) => {
    t.assert.deepStrictEqual(
      parseGitStatus([
        '# branch.oid abcdef1234567890',
        '# branch.head feature',
        '# branch.upstream origin/main',
        '# branch.ab +2 -3',
        '# stash 1',
        '1 M. N... 100644 100644 100644 abc abc staged.ts',
        '1 .M N... 100644 100644 100644 abc abc modified.ts',
        '2 MM N... 100644 100644 100644 abc abc R100 both.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 abc abc abc conflict.ts',
        '? new.ts',
      ].join('\n')),
      {
        ahead: 2,
        behind: 3,
        branch: 'feature',
        commit: 'abcdef1234567890',
        conflicted: 1,
        action: '',
        pushAhead: 0,
        pushBehind: 0,
        remoteBranch: 'main',
        staged: 2,
        stashes: 1,
        summary: '',
        tag: '',
        unstaged: 2,
        untracked: 1,
        upstream: 'origin/main',
      },
    );
  });

  void test('renders the two-sided shell UI', async (t: TestContext) => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type FooterFactory = Exclude<Parameters<ExtensionContext['ui']['setFooter']>[0], undefined>;
    type Renderable = {render(width: number): string[]};
    type EditorRenderable = Renderable & {
      getText(): string;
      handleInput(data: string): void;
      setText(text: string): void;
    };
    type WidgetFactory = (tui: unknown, theme: unknown) => Renderable;
    type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => EditorRenderable;
    let sessionStart: Handler | undefined;
    let footerFactory: FooterFactory | undefined;
    const statusWidgets = new Map<string, Renderable>();
    let editorFactory: EditorFactory | undefined;
    let userBashFinished: (() => void) | undefined;
    let gitStatusCalls = 0;
    let contextPercent = 25;
    const foregrounds: Array<[string, string]> = [];

    shellUi({
      events: {
        on(channel: string, handler: () => void) {
          if (channel === 'sloppi:user-bash-end') {
            userBashFinished = handler;
          }

          return () => undefined;
        },
      },
      async exec(_command: string, arguments_: string[]) {
        if (arguments_[0] === 'status') {
          gitStatusCalls += 1;
          return {
            code: 0,
            stdout: '# branch.oid abcdef1234567890\n# branch.head main\n1 .M N... 100644 100644 100644 abc abc modified.ts\n',
          };
        }

        return {code: 1, stdout: ''};
      },
      getActiveTools: () => ['read', 'bash'],
      getAllTools: () => [{name: 'read'}, {name: 'bash'}, {name: 'edit'}],
      getCommands: () => [
        {source: 'skill'},
        {source: 'prompt'},
      ],
      on(event: string, handler: Handler) {
        if (event === 'session_start') {
          sessionStart = handler;
        }
      },
    } as unknown as Parameters<typeof shellUi>[0]);

    const theme = {
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      fg(token: string, text: string) {
        foregrounds.push([token, text]);
        return text;
      },
    };
    const ctx = {
      cwd: '/repo',
      getContextUsage: () => ({contextWindow: 200_000, percent: contextPercent, tokens: 50_000}),
      hasPendingMessages: () => false,
      isIdle: () => true,
      isProjectTrusted: () => true,
      mode: 'tui',
      scopedModels: [],
      sessionManager: {
        getBranch: () => [
          {type: 'message', message: {role: 'assistant', usage: {cost: {total: 0.123}}}},
          {type: 'compaction', usage: {cost: {total: 0.004}}},
        ],
        getCwd: () => '/repo',
        getEntries: () => [],
        getSessionFile: () => '/sessions/test.jsonl',
        getSessionId: () => '12345678-abcd',
        getSessionName: () => undefined,
      },
      ui: {
        theme,
        setEditorComponent(factory: EditorFactory) {
          editorFactory = factory;
        },
        setFooter(factory: FooterFactory) {
          footerFactory = factory;
        },
        setWidget(id: string, factory: WidgetFactory, options?: {placement?: string}) {
          statusWidgets.set(`${options?.placement}:${id}`, factory({}, theme));
        },
      },
    } as unknown as ExtensionContext;

    await sessionStart?.({}, ctx);
    if (footerFactory === undefined) {
      throw new Error('Shell UI did not install its footer');
    }

    initTheme('dark', false);
    const footer = footerFactory(
      {
        requestRender() {
          return undefined;
        },
      } as never,
      theme as never,
      {
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => new Map([
          ['sandbox', 'sandbox status'],
          ['chat-mode', 'agent'],
          ['third-party', 'third-party status'],
          ['ponytail', 'ponytail status'],
        ]),
        getGitBranch: () => 'main',
        onBranchChange: () => () => undefined,
      },
    );
    t.assert.deepStrictEqual(footer.render(180), []);
    userBashFinished?.();
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
    t.assert.strictEqual(gitStatusCalls, 2);
    const topStatus = statusWidgets.get('belowEditor:shell-ui-top');
    const bottomStatus = statusWidgets.get('belowEditor:shell-ui-bottom');
    if (topStatus === undefined || bottomStatus === undefined || editorFactory === undefined) {
      throw new Error('Status widgets or prompt editor were not installed');
    }

    const lines = [...topStatus.render(180), ...bottomStatus.render(180)];
    const editor = editorFactory({terminal: {rows: 40}}, {
      borderColor: (text: string) => text,
      selectList: {},
    }, {matches: () => false});
    const editorLines = editor.render(80);

    t.assert.strictEqual(lines.length, 2);
    t.assert.match(lines[0] ?? '', /^├─ /v);
    t.assert.match(editorLines[0] ?? '', /^─+$/v);
    t.assert.match(editorLines[1] ?? '', /^╭─❯ /v);
    t.assert.match(lines[1] ?? '', /^╰─ /v);
    editor.setText('This input is long enough to wrap onto several visual lines.');
    const wrappedEditorLines = editor.render(20);
    t.assert.ok(wrappedEditorLines.length > 2);
    t.assert.ok(wrappedEditorLines.slice(2).every(line => /^│ {3}/v.test(line)));
    editor.setText('first');
    editor.handleInput('\u{1B}[13;2u');
    editor.handleInput('\u{1B}[200~pasted\nlines\u{1B}[201~');
    t.assert.strictEqual(editor.getText(), 'first\npasted\nlines');
    t.assert.ok(lines.every(line => visibleWidth(line) === 180));
    t.assert.match(lines[0] ?? '', /repo.* {2} main !1/v);
    t.assert.match(lines[0] ?? '', /─/v);
    t.assert.match(lines[0] ?? '', /no model.*off$/v);
    t.assert.match(lines[1] ?? '', /sandbox status.*agent.*third-party status.*ponytail status.*25\.0%.*50K\/200K.*\$0\.127.*󰆏 1$/v);
    t.assert.doesNotMatch(lines.join('\n'), /idle|busy|trusted|untrusted|[]/v);

    const contextColors = [10, 25, 45, 60].map(percent => {
      contextPercent = percent;
      foregrounds.length = 0;
      bottomStatus.render(180);
      return foregrounds.find(([, text]) => text === `${percent.toFixed(1)}%`)?.[0];
    });
    t.assert.deepStrictEqual(contextColors, ['accent', 'warning', 'syntaxNumber', 'error']);

    contextPercent = 25;
    const responsiveWidths = [20, 32, 40, 48, 60, 80, 100, 180];
    const responsiveLines = responsiveWidths.map(width => [
      ...topStatus.render(width),
      ...bottomStatus.render(width),
    ]);
    t.assert.ok(responsiveLines.every(rendered => rendered.length === 2));
    t.assert.ok(responsiveLines.every((rendered, index) =>
      rendered.every(line => visibleWidth(line) <= responsiveWidths[index]!)));

    const mobileLines = responsiveLines[2]?.join('\n') ?? '';
    t.assert.match(mobileLines, /repo {2}/v);
    t.assert.match(mobileLines, /sandbox status {2}agent {2}󰍛 25%/v);
    t.assert.doesNotMatch(mobileLines, /third-party|ponytail|no model|off|50K\/200K|󰆏/v);

    const compactLines = responsiveLines[5]?.join('\n') ?? '';
    t.assert.ok(['repo', '', 'main', 'sandbox status', 'agent', '25%', '$0.127']
      .every(part => compactLines.includes(part)));
    t.assert.ok(compactLines.endsWith('$0.127'));
    t.assert.doesNotMatch(compactLines, /third-party|ponytail|no model|off|50K\/200K|󰆏/v);

    t.assert.ok(responsiveWidths.every(width =>
      editor.render(width).every(line => visibleWidth(line) <= width)));
  });
});
