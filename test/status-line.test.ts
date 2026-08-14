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

  void test('renders OS, git, sandbox, and mode in order', async (t: TestContext) => {
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
        getBranch: () => [],
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
          ['0:sandbox', 'sandbox status'],
          ['0:ask-mode', 'default'],
          ['third-party', 'third-party status'],
          ['ponytail', 'ponytail status'],
        ]),
        getGitBranch: () => 'main',
        onBranchChange: () => () => undefined,
      },
    );
    const lines = footer.render(180);

    t.assert.strictEqual(lines.length, 3);
    t.assert.match(lines[0] ?? '', /(?:macOS|Linux).*repo.*main.*~1.*sandbox status.*default.*12345678/v);
    t.assert.match(lines[1] ?? '', /no model.*off.*25\.0%.*50K\/200K.*idle.*trusted/v);
    t.assert.match(lines[2] ?? '', /\$0\.000.*0 turns.*2\/3 tools.*1 skills\/1 prompts.*third-party status/v);
    t.assert.doesNotMatch(lines.join('\n'), /ponytail status/v);
    t.assert.deepStrictEqual(
      lines.map(line => [line.includes(''), /[]/v.test(line)]),
      [[true, false], [true, false], [true, false]],
    );

    const responsiveLines = [100, 60].map(width => footer.render(width));
    t.assert.deepStrictEqual(responsiveLines.map(rendered => rendered.length), [2, 1]);
    t.assert.deepStrictEqual(
      responsiveLines.map((rendered, index) => rendered.every(line => visibleWidth(line) <= [100, 60][index]!)),
      [true, true],
    );
  });
});
