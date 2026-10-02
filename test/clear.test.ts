import {test, type TestContext} from 'node:test';
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {Container, Spacer} from '@earendil-works/pi-tui';
import clear from '../agent/extensions/clear.ts';

/**
 Verifies `/clear` adds blank fullscreen transcript space while retaining the
 existing chat components and input dock.
 */
void test('clears the fullscreen viewport without deleting chat history', async (t: TestContext) => {
  type CommandOptions = Parameters<Parameters<typeof clear>[0]['registerCommand']>[1];
  let command: CommandOptions | undefined;
  let sessionStart: ((event: never, ctx: ExtensionContext) => void) | undefined;
  let wasRendered = false;
  let onTerminalInput: ((data: string) => unknown) | undefined;
  const document = new Container();
  const chat = new Container();

  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  chat.addChild(new Container());

  clear({
    on(name: string, handler: (event: never, ctx: ExtensionContext) => void) {
      if (name === 'session_start') {
        sessionStart = handler;
      }
    },
    registerCommand(_name: string, options: CommandOptions) {
      command = options;
    },
  } as unknown as Parameters<typeof clear>[0]);

  sessionStart?.(undefined as never, {
    mode: 'tui',
    ui: {
      onTerminalInput(handler) {
        onTerminalInput = handler;
        return () => undefined;
      },
      setWidget(_key, factory) {
        if (typeof factory === 'function') {
          factory({
            children: [document],
            mode: 'fullscreen',
            requestRender() {
              wasRendered = true;
            },
            terminal: {rows: 24},
          } as never, {} as never);
        }
      },
    },
  } as ExtensionContext);
  await command?.handler('', {mode: 'tui'} as ExtensionCommandContext);

  t.assert.strictEqual(chat.children.length, 2);
  t.assert.ok(chat.children.at(1) instanceof Spacer);
  t.assert.strictEqual(wasRendered, true);

  wasRendered = false;
  onTerminalInput?.('up');
  t.assert.strictEqual(chat.children.length, 1);
  t.assert.strictEqual(wasRendered, true);
});
