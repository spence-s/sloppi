import {spawnSync} from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
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
import {readZshHistory} from '../agent/extensions/shell/history.ts';
import shellUi from '../agent/extensions/shell-ui.ts';
import zshrc from '../agent/extensions/zshrc.ts';

/**
Exercises command recording, native history decoding, and editor recall across
real Zsh processes with a private history file. Failed, exiting, multiline, and
timed-out commands must be saved before execution without displacing older entries.
History configuration is passed through environment variables because the sandbox
forbids writing shell startup fixtures. The original wrapper test separately
protects non-interactive alias-aware execution. Nothing in this test reads or
changes the user's actual history or startup file.
*/
void test('configured Zsh records user commands and the shell editor recalls native history', async (t: TestContext) => {
  const resolved = spawnSync('which', ['zsh'], {encoding: 'utf8'});
  if (resolved.status !== 0) {
    t.skip('Zsh is not installed.');
    return;
  }

  const shell = resolved.stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-zsh-history-'));
  let historyFile = join(directory, 'history');
  const env = {
    ...process.env,
    SHELL: shell,
    HOME: directory,
    ZDOTDIR: directory,
    HISTFILE: historyFile,
    SAVEHIST: '1000',
  };
  t.mock.property(process, 'env', env);

  try {
    // Resolve HISTFILE using the same non-interactive startup as lookup.
    // Resolve the actual configuration rather than assuming inherited env wins.
    const configured = await execa(shell, ['-f', '-c', 'source ~/.zshrc >/dev/null; builtin print -rn -- "$HISTFILE"'], {env});
    historyFile = configured.stdout;
    if (!historyFile.startsWith(`${directory}/`)) {
      throw new Error('Test shell selected history outside its private HOME');
    }

    let configuredShell = shell;
    type SessionHandler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
    type UserHandler = (event: UserBashEvent, ctx: ExtensionContext) => UserBashEventResult | undefined;
    type EditorFactory = Exclude<Parameters<ExtensionContext['ui']['setEditorComponent']>[0], undefined>;
    let sessionStart: SessionHandler | undefined;
    let userBash: UserHandler | undefined;
    let editorFactory: EditorFactory | undefined;
    const notifications: string[] = [];
    const completed: unknown[] = [];
    let search = Promise.withResolvers<void>();
    const api = {
      getSettings: () => ({shellPath: configuredShell}),
      events: {
        on: () => () => undefined,
        emit(channel: string, command: unknown) {
          if (channel === 'sloppi:user-bash-end') {
            completed.push(command);
          }
        },
      },
      /**
      Runs the production history script against isolated storage. Git status is
      unrelated to this integration, and the completion signal lets the test wait
      for the editor's asynchronous request without timing-dependent sleeps.
      */
      async exec(command: string, arguments_: string[], options: {cwd?: string; timeout?: number}) {
        if (command === 'git') {
          return {
            code: 1, stdout: '', stderr: '', killed: false,
          };
        }

        try {
          const result = await execa(command, arguments_, {env, ...options, reject: false});
          return {
            code: result.exitCode, stdout: result.stdout, stderr: result.stderr, killed: false,
          };
        } finally {
          if (arguments_[0] === '-f' && arguments_[1] === '-c') {
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
    const ctx = {
      cwd: directory,
      mode: 'tui',
      hasUI: true,
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
    zshrc(api);
    shellUi(api);
    if (userBash === undefined || sessionStart === undefined) {
      throw new Error('User shell or editor lifecycle was not registered');
    }

    const empty = await readZshHistory(api, directory);
    t.assert.strictEqual(empty.stdout, '');
    // Seed extended history as another terminal would write it, including a
    // literal pattern character that must not become a search wildcard.
    await writeFile(historyFile, ': 1700000000:0;echo external\n: 1700000001:0;echo [literal]\n: 1700000002:0;printf older\n: 1700000003:0;printf first\\\nsecond\n');
    const commands = ['printf \'%s\' \'quoted input\'', 'false', 'exit 7', 'printf \'first\\n\'\nprintf \'second\\n\''];
    const exitCodes: Array<number | undefined> = [];
    for (const command of commands) {
      const result = userBash({
        type: 'user_bash', command, cwd: directory, excludeFromContext: true,
      }, ctx);
      if (result?.operations === undefined) {
        throw new Error('User shell operations were not installed');
      }

      // Pi executes user commands serially; preserve that boundary in the test.
      // eslint-disable-next-line no-await-in-loop
      const executed = await result.operations.exec(command, directory, {onData: () => undefined});
      exitCodes.push(executed.exitCode ?? undefined);
    }

    t.assert.deepStrictEqual(exitCodes, [0, 1, 7, 0]);
    await waitForImmediate();
    t.assert.deepStrictEqual(completed, commands);
    const beforeRead = await readFile(historyFile, 'utf8');
    const recorded = await readZshHistory(api, directory);
    t.assert.strictEqual(recorded.code, 0, recorded.stderr);
    t.assert.deepStrictEqual(recorded.stdout.split('\0').filter(Boolean), [
      ...commands.toReversed(),
      'printf first\nsecond',
      'printf older',
      'echo [literal]',
      'echo external',
    ]);
    t.assert.strictEqual(await readFile(historyFile, 'utf8'), beforeRead);

    const cancelledCommand = 'sleep 10';
    const cancelled = userBash({
      type: 'user_bash', command: cancelledCommand, cwd: directory, excludeFromContext: true,
    }, ctx);
    if (cancelled?.operations === undefined) {
      throw new Error('User shell operations were not installed');
    }

    // Allow shell startup and history recording to finish on slower CI runners
    // before cancellation; sleep 10 still outlasts this one-second timeout.
    await t.assert.rejects(cancelled.operations.exec(cancelledCommand, directory, {onData: () => undefined, timeout: 1}), /timeout/v);
    const afterTimeout = await readZshHistory(api, directory);
    t.assert.strictEqual(afterTimeout.code, 0, afterTimeout.stderr);
    t.assert.deepStrictEqual(afterTimeout.stdout.split('\0').filter(Boolean), [
      cancelledCommand,
      ...recorded.stdout.split('\0').filter(Boolean),
    ]);
    initTheme('dark', false);
    await sessionStart({}, ctx);
    if (editorFactory === undefined) {
      throw new Error('Shell editor was not installed');
    }

    const editor = editorFactory({requestRender: () => undefined} as never, {
      borderColor: (text: string) => text,
      selectList: {},
    } as never, {
      matches: (data: string, action: string) => (data === '\u{1B}[A' && action === 'tui.editor.cursorUp')
        || (data === '\u{1B}[B' && action === 'tui.editor.cursorDown'),
    } as never);
    search = Promise.withResolvers<void>();
    editor.setText('!!printf');
    editor.handleInput('\u{1B}[A');
    await search.promise;
    await waitForImmediate();
    t.assert.strictEqual(editor.getText(), `!!${commands.at(-1) ?? ''}`);
    editor.handleInput('\u{1B}[A');
    t.assert.strictEqual(editor.getText(), `!!${commands[0] ?? ''}`);
    editor.handleInput('\u{1B}[B');
    editor.handleInput('\u{1B}[B');
    t.assert.strictEqual(editor.getText(), '!!printf');
    t.assert.deepStrictEqual(notifications, []);

    search = Promise.withResolvers<void>();
    editor.setText('!echo [');
    editor.handleInput('\u{1B}[A');
    await search.promise;
    await waitForImmediate();
    t.assert.strictEqual(editor.getText(), '!echo [literal]');

    // Fail before running the reader if it requests interactive/login mode.
    // This fixture also keeps startup diagnostics separate from history data.
    configuredShell = join(directory, 'zsh');
    await writeFile(configuredShell, `#!/bin/sh
[ "$1" = "-f" ] && [ "$2" = "-c" ] || exit 90
exec '${shell}' -f -c '
[[ ! -o interactive && ! -o login ]] || exit 91
builtin print -r -- "startup stdout"
builtin print -ru2 -- "harmless startup diagnostic"
eval -- "$1"
' fixture "$3"
`);
    await chmod(configuredShell, 0o755);
    env.SHELL = '/bin/bash';
    const aliasHistory = await readZshHistory(api, directory);
    t.assert.strictEqual(aliasHistory.code, 0);
    t.assert.match(aliasHistory.stderr, /harmless startup diagnostic/v);
    t.assert.deepStrictEqual(aliasHistory.stdout.split('\0').filter(Boolean), afterTimeout.stdout.split('\0').filter(Boolean));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
