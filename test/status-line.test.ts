import {describe, test, type TestContext} from 'node:test';
import {initTheme, type ExtensionContext} from '@earendil-works/pi-coding-agent';
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

  void test('renders OS and git below third-party extension statuses', async (t: TestContext) => {
    type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type FooterFactory = Exclude<Parameters<ExtensionContext['ui']['setFooter']>[0], undefined>;
    let sessionStart: Handler | undefined;
    let footerFactory: FooterFactory | undefined;

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

    const theme = {fg: (_token: string, text: string) => text};
    const ctx = {
      cwd: '/repo',
      getContextUsage: () => undefined,
      mode: 'tui',
      sessionManager: {
        getCwd: () => '/repo',
        getEntries: () => [],
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
          ['0:sudo-gate', 'sudo: denied'],
          ['1:delete-gate', 'delete: ask'],
          ['third-party', 'third-party status'],
        ]),
        getGitBranch: () => null,
        onBranchChange: () => () => undefined,
      },
    );
    const lines = footer.render(120);

    t.assert.strictEqual(lines.at(-2), 'third-party status');
    t.assert.match(
      lines.at(-1) ?? '',
      /(?:macOS|Ubuntu) \| .*~1 \| sudo: denied \| delete: ask$/v,
    );
  });
});
