import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

type AskModeState = {
  isEnabled: boolean;
  toolsBeforeAskMode: string[] | undefined;
};

const askModeStatusId = '0:ask-mode';
const askModeEntryType = 'ask-mode';
const askModeEnabledContext =
  'Ask mode is active. You may only use the read tool. Do not call bash, edit, write, or other tools.';
const askModeDisabledContext =
  'Ask mode is inactive. You may call available tools normally.';
const askModeBlockedReason =
  'Ask mode is enabled: only file reads are allowed. Use /ask off to re-enable full tool access.';

export function onToolCall(
  event: ToolCallEvent,
  isAskModeEnabled: boolean,
): ToolCallEventResult | void {
  if (!isAskModeEnabled || event.toolName === 'read') {
    return;
  }

  return {
    block: true,
    reason: askModeBlockedReason,
  };
}

export default function askMode(pi: ExtensionAPI): void {
  let isAskModeEnabled = false;
  let toolsBeforeAskMode: string[] | undefined;

  const setAskMode = (
    isEnabled: boolean,
    ctx: ExtensionContext,
    shouldNotify: boolean,
  ): void => {
    if (isEnabled === isAskModeEnabled) {
      return;
    }

    if (isEnabled) {
      toolsBeforeAskMode ??= pi.getActiveTools();
      pi.setActiveTools(['read']);
    } else {
      pi.setActiveTools(toolsBeforeAskMode ?? pi.getActiveTools());
      toolsBeforeAskMode = undefined;
    }

    isAskModeEnabled = isEnabled;
    pi.appendEntry<AskModeState>(askModeEntryType, {
      isEnabled: isAskModeEnabled,
      toolsBeforeAskMode,
    });

    ctx.ui.setStatus(
      askModeStatusId,
      isAskModeEnabled
        ? `${ctx.ui.theme.fg('accent', '💬')} ${ctx.ui.theme.fg('warning', 'ask mode')}`
        : undefined,
    );

    if (!shouldNotify) {
      return;
    }

    ctx.ui.notify(
      isAskModeEnabled
        ? 'Ask mode enabled. Only file reads are allowed.'
        : 'Ask mode disabled. Tool access restored.',
      'info',
    );
  };

  const syncFromSession = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();

    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== 'custom' || entry.customType !== askModeEntryType) {
        continue;
      }

      const state = entry.data as AskModeState | undefined;
      if (state === undefined) {
        break;
      }

      isAskModeEnabled = state.isEnabled;
      toolsBeforeAskMode = state.toolsBeforeAskMode;
      break;
    }

    if (isAskModeEnabled) {
      toolsBeforeAskMode ??= pi.getActiveTools();
      pi.setActiveTools(['read']);
    }

    ctx.ui.setStatus(
      askModeStatusId,
      isAskModeEnabled
        ? `${ctx.ui.theme.fg('accent', '💬')} ${ctx.ui.theme.fg('warning', 'ask mode')}`
        : undefined,
    );
  };

  pi.registerCommand('ask', {
    description:
      'Toggle ask mode (read-only tool access). Usage: /ask [on|off|toggle|status]',
    async handler(args, ctx) {
      const normalized = args?.trim().toLowerCase();
      const command =
        normalized === undefined || normalized.length === 0
          ? 'toggle'
          : normalized;

      switch (command) {
        case 'on': {
          setAskMode(true, ctx, true);
          return;
        }

        case 'off': {
          setAskMode(false, ctx, true);
          return;
        }

        case 'toggle': {
          setAskMode(!isAskModeEnabled, ctx, true);
          return;
        }

        default: {
          ctx.ui.notify(
            isAskModeEnabled
              ? 'Ask mode is currently enabled.'
              : 'Ask mode is currently disabled.',
            'info',
          );
        }
      }
    },
  });

  pi.on('before_agent_start', async () => ({
    message: {
      customType: 'ask-mode-context',
      content: isAskModeEnabled
        ? askModeEnabledContext
        : askModeDisabledContext,
      display: false,
    },
  }));

  pi.on('tool_call', async (event) => onToolCall(event, isAskModeEnabled));

  pi.on('session_start', async (_event, ctx) => {
    syncFromSession(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    syncFromSession(ctx);
  });
}
