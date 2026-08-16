import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

type ChatModeState = {
  isEnabled: boolean;
  toolsBeforeChatMode: string[] | undefined;
};

const chatModeStatusId = 'chat-mode';
const chatModeEntryType = 'chat-mode';
const chatModeTools = ['read', 'grep', 'find', 'ls', 'web_search', 'source_check', 'fetch_content', 'get_search_content'];
const chatModeEnabledContext =
  'Chat mode is active. You may use read-only tools and web research. Do not call bash, edit, or write.';
const agentModeContext =
  'Agent mode is active. You may call available tools normally, including bash, edit, write, or other tools.';
const chatModeBlockedReason =
  'Chat mode is enabled: only read-only tools and web research are allowed. Use /chat off to re-enable full tool access.';

export function onToolCall(
  event: ToolCallEvent,
  isChatModeEnabled: boolean,
): ToolCallEventResult | void {
  if (!isChatModeEnabled || chatModeTools.includes(event.toolName)) {
    return;
  }

  return {
    block: true,
    reason: chatModeBlockedReason,
  };
}

export default function chatMode(pi: ExtensionAPI): void {
  let isChatModeEnabled = false;
  let toolsBeforeChatMode: string[] | undefined;

  const setChatMode = (
    isEnabled: boolean,
    ctx: ExtensionContext,
    shouldNotify: boolean,
  ): void => {
    if (isEnabled === isChatModeEnabled) {
      return;
    }

    if (isEnabled) {
      toolsBeforeChatMode ??= pi.getActiveTools();
      pi.setActiveTools(chatModeTools);
    } else {
      pi.setActiveTools(toolsBeforeChatMode ?? pi.getActiveTools());
      toolsBeforeChatMode = undefined;
    }

    isChatModeEnabled = isEnabled;
    pi.appendEntry<ChatModeState>(chatModeEntryType, {
      isEnabled: isChatModeEnabled,
      toolsBeforeChatMode,
    });

    ctx.ui.setStatus(
      chatModeStatusId,
      `${ctx.ui.theme.fg(isChatModeEnabled ? 'accent' : 'success', '󰒓')} ${ctx.ui.theme.fg('dim', isChatModeEnabled ? 'chat' : 'agent')}`,
    );

    if (!shouldNotify) {
      return;
    }

    ctx.ui.notify(
      isChatModeEnabled
        ? 'Chat mode enabled. Read-only tools and web research are allowed.'
        : 'Agent mode enabled. Full tool access restored.',
      'info',
    );
  };

  const syncFromSession = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();

    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== 'custom' || entry.customType !== chatModeEntryType) {
        continue;
      }

      const state = entry.data;
      if (
        typeof state !== 'object'
        || state === null
        || !('isEnabled' in state)
        || typeof state.isEnabled !== 'boolean'
        || !('toolsBeforeChatMode' in state)
        || !Array.isArray(state.toolsBeforeChatMode)
        || state.toolsBeforeChatMode.some(tool => typeof tool !== 'string')
      ) {
        break;
      }

      isChatModeEnabled = state.isEnabled;
      toolsBeforeChatMode = state.toolsBeforeChatMode;
      break;
    }

    if (isChatModeEnabled) {
      toolsBeforeChatMode ??= pi.getActiveTools();
      pi.setActiveTools(chatModeTools);
    }

    ctx.ui.setStatus(
      chatModeStatusId,
      `${ctx.ui.theme.fg(isChatModeEnabled ? 'accent' : 'success', '󰒓')} ${ctx.ui.theme.fg('dim', isChatModeEnabled ? 'chat' : 'agent')}`,
    );
  };

  pi.registerCommand('chat', {
    description:
      'Toggle modes, optionally submitting a prompt afterward. Usage: /chat [on|off|toggle|status|prompt]',
    async handler(args, ctx) {
      const input = args?.trim() ?? '';
      const command = input.length === 0 ? 'toggle' : input.toLowerCase();

      switch (command) {
        case 'on': {
          setChatMode(true, ctx, true);
          return;
        }

        case 'off': {
          setChatMode(false, ctx, true);
          return;
        }

        case 'toggle': {
          setChatMode(!isChatModeEnabled, ctx, true);
          return;
        }

        case 'status': {
          ctx.ui.notify(
            isChatModeEnabled
              ? 'Chat mode is currently active.'
              : 'Agent mode is currently active.',
            'info',
          );
          return;
        }

        default: {
          setChatMode(!isChatModeEnabled, ctx, false);
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
      customType: 'chat-mode-context',
      content: isChatModeEnabled
        ? chatModeEnabledContext
        : agentModeContext,
      display: false,
    },
  }));

  pi.on('tool_call', async event => onToolCall(event, isChatModeEnabled));

  pi.on('session_start', async (_event, ctx) => {
    syncFromSession(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    syncFromSession(ctx);
  });
}
