import {describe, test, type TestContext} from 'node:test';
import {initTheme, type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {visibleWidth} from '@earendil-works/pi-tui';
import statusLine, {parseGitStatus} from '../agent/extensions/status-line.ts';

void describe('status line', () => {
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

  void test('renders a two-sided shell-style status line', async (t: TestContext) => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type FooterFactory = Exclude<Parameters<ExtensionContext['ui']['setFooter']>[0], undefined>;
    let sessionStart: Handler | undefined;
    let footerFactory: FooterFactory | undefined;

    statusLine({
      async exec(_command: string, arguments_: string[]) {
        if (arguments_[0] === 'status') {
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
    t.assert.match(lines[0] ?? '', /repo.* main.*!1/v);
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
