import {describe, test, type TestContext} from 'node:test';
import {initTheme, type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {visibleWidth} from '@earendil-works/pi-tui';
import statusLine, {parseGitStatus} from '../agent/extensions/status-line.ts';

void describe('status line', () => {
  void test('counts staged, modified, and untracked files', (t: TestContext) => {
    t.assert.deepStrictEqual(
      parseGitStatus('M  staged.ts\n M modified.ts\nMM both.ts\n?? new.ts\n'),
      {staged: 2, modified: 2, untracked: 1},
    );
  });

  void test('renders a two-sided shell-style status line', async (t: TestContext) => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type FooterFactory = Exclude<Parameters<ExtensionContext['ui']['setFooter']>[0], undefined>;
    let sessionStart: Handler | undefined;
    let footerFactory: FooterFactory | undefined;

    statusLine({
      async exec() {
        return {code: 0, stdout: ' M modified.ts\n'};
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
    } as unknown as Parameters<typeof statusLine>[0]);

    const theme = {
      bg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      fg: (_token: string, text: string) => text,
    };
    const ctx = {
      cwd: '/repo',
      getContextUsage: () => ({contextWindow: 200_000, percent: 25, tokens: 50_000}),
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
        setFooter(factory: FooterFactory) {
          footerFactory = factory;
        },
      },
    } as unknown as ExtensionContext;

    await sessionStart?.({}, ctx);
    if (footerFactory === undefined) {
      throw new Error('Status line did not install its footer');
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
    const lines = footer.render(180);

    t.assert.strictEqual(lines.length, 2);
    t.assert.deepStrictEqual(lines.map(line => line.slice(0, 2)), ['╭─', '╰─']);
    t.assert.match(lines[0] ?? '', /repo.*on.*main.*~1/v);
    t.assert.match(lines[0] ?? '', /─/v);
    t.assert.match(lines[0] ?? '', /no model$/v);
    t.assert.match(lines[1] ?? '', /idle.*off.*sandbox status.*agent.*25\.0%.*50K\/200K.*\$0\.127.*󰆏 1$/v);
    t.assert.doesNotMatch(lines.join('\n'), /third-party status|ponytail status|trusted|untrusted|[]/v);

    const responsiveLines = [100, 60].map(width => footer.render(width));
    t.assert.deepStrictEqual(responsiveLines.map(rendered => rendered.length), [2, 2]);
    t.assert.deepStrictEqual(
      responsiveLines.map((rendered, index) => rendered.every(line => visibleWidth(line) <= [100, 60][index]!)),
      [true, true],
    );
  });
});
