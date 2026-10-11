import {spawnSync} from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {test, type TestContext} from 'node:test';
import {setImmediate as waitForImmediate} from 'node:timers/promises';
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type UserBashEvent,
  type UserBashEventResult,
} from '@earendil-works/pi-coding-agent';
import {execa} from 'execa';
import atuin from '../agent/extensions/atuin.ts';
import shellUi from '../agent/extensions/shell-ui.ts';

void test('real Atuin recording returns the latest user command to the !! editor', async (t: TestContext) => {
  const version = spawnSync('atuin', ['--version'], {encoding: 'utf8'});
  if (version.error?.message.includes('ENOENT')) {
    t.skip('Atuin is not installed; deterministic editor ordering is covered in shell-ui.test.ts.');
    return;
  }

  t.assert.strictEqual(version.status, 0, version.stderr);
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-atuin-editor-test-'));

  try {
    const configDirectory = join(directory, 'config');
    const shellPath = join(directory, 'test-shell');
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, 'config.toml'), 'auto_sync = false\nupdate_check = false\n');
    // Only recording and recall are under test: never actually commit or push.
    await writeFile(shellPath, '#!/bin/sh\nexit 0\n');
    await chmod(shellPath, 0o755);
    const env = {
      ...process.env,
      ATUIN_CONFIG_DIR: configDirectory,
      HOME: directory,
      XDG_CONFIG_HOME: configDirectory,
      XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      SHELL: shellPath,
      ATUIN_SESSION: '',
    };
    const session = await execa('atuin', ['uuid'], {env});
    env.ATUIN_SESSION = session.stdout;
    t.mock.property(process, 'env', env);

    type SessionHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type UserHandler = (event: UserBashEvent) => UserBashEventResult | undefined;
    type EditorFactory = Exclude<Parameters<ExtensionContext['ui']['setEditorComponent']>[0], undefined>;
    let sessionStart: SessionHandler | undefined;
    let userBash: UserHandler | undefined;
    const search = Promise.withResolvers<void>();
    const notifications: string[] = [];
    const api = {
      events: {on: () => () => undefined},
      /**
      Uses the real CLI against private configuration and storage while leaving
      Git status unrelated to this fixture. Search completion is exposed only to
      let the test wait for the editor's asynchronous history request.
      */
      async exec(command: string, arguments_: string[], options: {cwd?: string; timeout?: number}) {
        if (command !== 'atuin') {
          return {code: 1, stdout: '', stderr: ''};
        }

        try {
          const result = await execa(command, arguments_, {env, ...options, reject: false});
          return {code: result.exitCode, stdout: result.stdout, stderr: result.stderr};
        } finally {
          if (arguments_[0] === 'search') {
            search.resolve();
          }
        }
      },
      on(name: string, handler: SessionHandler | UserHandler) {
        if (name === 'session_start') {
          sessionStart = handler as SessionHandler;
        } else if (name === 'user_bash') {
          userBash = handler as UserHandler;
        }
      },
    } as unknown as ExtensionAPI;
    atuin(api);
    shellUi(api);
    if (sessionStart === undefined || userBash === undefined) {
      throw new Error('Recording or editor lifecycle was not registered');
    }

    let editorFactory: EditorFactory | undefined;
    const ctx = {
      cwd: directory,
      mode: 'tui',
      sessionManager: {getBranch: () => []},
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setFooter: () => undefined,
        setEditorComponent(factory: EditorFactory) {
          editorFactory = factory;
        },
      },
    } as unknown as ExtensionContext;

    for (const command of ['git commit -m example', 'ggp']) {
      const result = userBash({
        command,
        cwd: directory,
        excludeFromContext: true,
        type: 'user_bash',
      });
      if (result?.operations === undefined) {
        throw new Error('User Bash operations were not installed');
      }

      // User commands are serial in Pi, and the next must start after history end.
      // eslint-disable-next-line no-await-in-loop
      await result.operations.exec(command, directory, {onData: () => undefined});
    }

    // A newer agent entry must not displace the most recent host input.
    const agentStart = await api.exec('atuin', ['history', 'start', '--author', 'pi', '--author-kind', 'agent', '--', 'git status'], {cwd: directory});
    const agentId = agentStart.stdout.trim();
    await api.exec('atuin', ['history', 'end', agentId, '--exit', '0'], {cwd: directory});
    initTheme('dark', false);
    await sessionStart({}, ctx);
    if (editorFactory === undefined) {
      throw new Error('Shell editor was not installed');
    }

    const editor = editorFactory({requestRender: () => undefined} as never, {
      borderColor: (text: string) => text,
      selectList: {},
    } as never, {
      matches: (data: string, action: string) => data === '\u{1B}[A' && action === 'tui.editor.cursorUp',
    } as never);
    editor.setText('!!');
    editor.handleInput('\u{1B}[A');
    await search.promise;
    await waitForImmediate();
    t.assert.strictEqual(editor.getText(), '!!ggp');
    editor.handleInput('\u{1B}[A');
    t.assert.strictEqual(editor.getText(), '!!git commit -m example');
    t.assert.deepStrictEqual(notifications, []);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
