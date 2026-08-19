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

const askModeStatusId = 'ask-mode';
const askModeEntryType = 'ask-mode';
const askModeTools = ['read', 'grep', 'find', 'ls', 'web_search', 'source_check', 'fetch_content', 'get_search_content'];
const askModeEnabledContext =
  'Ask mode is active. You may use read-only tools and web research. Do not call bash, edit, or write.';
const agentModeContext =
  'Agent mode is active. You may call available tools normally, including bash, edit, write, or other tools.';
const askModeBlockedReason =
  'Ask mode is enabled: only read-only tools and web research are allowed. Use /ask off to re-enable full tool access.';

export function onToolCall(
  event: ToolCallEvent,
  isAskModeEnabled: boolean,
): ToolCallEventResult | void {
  if (!isAskModeEnabled || askModeTools.includes(event.toolName)) {
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
      pi.setActiveTools(askModeTools);
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
      `${ctx.ui.theme.fg(isAskModeEnabled ? 'accent' : 'muted', isAskModeEnabled ? '󰋼' : '󰚩')} ${ctx.ui.theme.fg('dim', isAskModeEnabled ? 'ask' : 'agent')}`,
    );

    if (!shouldNotify) {
      return;
    }

    ctx.ui.notify(
      isAskModeEnabled
        ? 'Ask mode enabled. Read-only tools and web research are allowed.'
        : 'Agent mode enabled. Full tool access restored.',
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

      const state = entry.data;
      if (
        typeof state !== 'object'
        || state === null
        || !('isEnabled' in state)
        || typeof state.isEnabled !== 'boolean'
        || !('toolsBeforeAskMode' in state)
        || !Array.isArray(state.toolsBeforeAskMode)
        || state.toolsBeforeAskMode.some(tool => typeof tool !== 'string')
      ) {
        break;
      }

      isAskModeEnabled = state.isEnabled;
      toolsBeforeAskMode = state.toolsBeforeAskMode;
      break;
    }

    if (isAskModeEnabled) {
      toolsBeforeAskMode ??= pi.getActiveTools();
      pi.setActiveTools(askModeTools);
    }

    ctx.ui.setStatus(
      askModeStatusId,
      `${ctx.ui.theme.fg(isAskModeEnabled ? 'accent' : 'muted', isAskModeEnabled ? '󰋼' : '󰚩')} ${ctx.ui.theme.fg('dim', isAskModeEnabled ? 'ask' : 'agent')}`,
    );
  };

  pi.registerCommand('ask', {
    description:
      'Toggle modes, optionally submitting a prompt afterward. Usage: /ask [on|off|toggle|status|prompt]',
    async handler(args, ctx) {
      const input = args?.trim() ?? '';
      const command = input.length === 0 ? 'toggle' : input.toLowerCase();

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

        case 'status': {
          ctx.ui.notify(
            isAskModeEnabled
              ? 'Ask mode is currently active.'
              : 'Agent mode is currently active.',
            'info',
          );
          return;
        }

        default: {
          setAskMode(!isAskModeEnabled, ctx, false);
          if (ctx.isIdle()) {
            pi.sendUserMessage(input);
          } else {
            pi.sendUserMessage(input, {deliverAs: 'followUp'});
          }
        }
      }
    },
  });

  pi.on('before_agent_start', async () => ({
    message: {
      customType: 'ask-mode-context',
      content: isAskModeEnabled
        ? askModeEnabledContext
        : agentModeContext,
      display: false,
    },
  }));

  pi.on('tool_call', async event => onToolCall(event, isAskModeEnabled));

  pi.on('session_start', async (_event, ctx) => {
    syncFromSession(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    syncFromSession(ctx);
  });
}
