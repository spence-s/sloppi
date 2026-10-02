import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Container, Spacer, type TUI} from '@earendil-works/pi-tui';

/**
 Adds `/clear` for fullscreen Pi. It appends temporary blank transcript space,
 which moves history above the fixed input dock without deleting it.
 */
export default function clear(pi: ExtensionAPI): void {
  let tui: TUI | undefined;
  let chat: Container | undefined;
  let clearedSpace: Spacer | undefined;

  /**
   Removes the temporary visual gap without touching Pi's persisted session.
   The same gap must be cleared when the user resumes input, when an agent
   starts automatically, or before a second `/clear` replaces it.
   */
  function didRemoveClearedSpace(): boolean {
    if (chat === undefined || clearedSpace === undefined) {
      return false;
    }

    // Pi TUI components are not DOM nodes; Container owns removal.
    // eslint-disable-next-line unicorn/prefer-dom-node-remove
    chat.removeChild(clearedSpace);
    chat = undefined;
    clearedSpace = undefined;
    return true;
  }

  /**
   Captures Pi's active renderer through an empty widget because command
   handlers receive UI controls but not the terminal renderer itself.
   */
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    ctx.ui.setWidget('clear-screen', renderer => {
      tui = renderer;
      return {
        /**
         Has no state or visible output, so invalidation requires no work.
         */
        invalidate() {
          return undefined;
        },
        /**
         Exists only to capture the renderer and must occupy no screen rows.
         */
        render() {
          return [];
        },
      };
    });

    /**
     Dismisses the visual clear as soon as the user scrolls or types again.
     Returning nothing leaves the original input available to Pi's editor and
     fullscreen viewport, including wheel events that reveal prior history.
     */
    ctx.ui.onTerminalInput(() => {
      if (didRemoveClearedSpace()) {
        tui?.requestRender();
      }
    });
  });

  /**
   Removes the blank gap before an automatic agent response so new messages
   continue directly after the existing transcript.
   */
  pi.on('agent_start', () => {
    if (didRemoveClearedSpace()) {
      tui?.requestRender();
    }
  });

  pi.registerCommand('clear', {
    description: 'Clear the fullscreen viewport while retaining scrollable history.',
    /**
     Places one screen of blank transcript content after history. Fullscreen's
     transcript follows its end, so the fixed input remains visible and normal
     transcript scrolling reaches all prior messages.
     */
    async handler(_arguments, ctx) {
      if (ctx.mode !== 'tui' || tui?.mode !== 'fullscreen') {
        return;
      }

      const document = tui.children.at(0);
      const currentChat = document instanceof Container ? document.children.at(2) : undefined;
      if (!(currentChat instanceof Container)) {
        return;
      }

      didRemoveClearedSpace();
      chat = currentChat;
      clearedSpace = new Spacer(Math.max(1, tui.terminal.rows));
      chat.addChild(clearedSpace);
      tui.requestRender();
    },
  });
}
