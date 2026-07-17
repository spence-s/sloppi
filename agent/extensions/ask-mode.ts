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
const askModeAllowedTools = ['read'] as const;
const askModeEnabledContext =
  'Ask mode is active. You may only use the read tool. Do not call bash, edit, write, or other tools.';
const askModeDisabledContext =
  'Ask mode is inactive. You may call available tools normally.';
const askModeBlockedReason =
  'Ask mode is enabled: only file reads are allowed. Use /ask off to re-enable full tool access.';

function parseAskCommandInput(
  args: string | undefined,
): 'on' | 'off' | 'toggle' | 'status' {
  const normalized = args?.trim().toLowerCase();

  if (normalized === undefined || normalized.length === 0) {
    return 'toggle';
  }

  const validCommands = ['on', 'off', 'toggle', 'status'] as const;
  if (validCommands.includes(normalized as (typeof validCommands)[number])) {
    return normalized as (typeof validCommands)[number];
  }

  return 'status';
}

function updateAskModeStatus(isEnabled: boolean, ctx: ExtensionContext): void {
  if (isEnabled) {
    ctx.ui.setStatus(
      askModeStatusId,
      `${ctx.ui.theme.fg('accent', '💬')} ${ctx.ui.theme.fg('warning', 'ask mode')}`,
    );
    return;
  }

  ctx.ui.setStatus(askModeStatusId, undefined);
}

function restoreAskModeState(ctx: ExtensionContext): AskModeState {
  const state: AskModeState = {
    isEnabled: false,
    toolsBeforeAskMode: undefined,
  };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== askModeEntryType) {
      continue;
    }

    const data = entry.data as AskModeState | undefined;
    if (data === undefined) {
      continue;
    }

    state.isEnabled = data.isEnabled;
    state.toolsBeforeAskMode = data.toolsBeforeAskMode;
  }

  return state;
}

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

  function persistAskModeState(): void {
    pi.appendEntry<AskModeState>(askModeEntryType, {
      isEnabled: isAskModeEnabled,
      toolsBeforeAskMode,
    });
  }

  function enableAskMode(ctx: ExtensionContext): void {
    if (isAskModeEnabled) {
      return;
    }

    toolsBeforeAskMode ??= pi.getActiveTools();

    pi.setActiveTools([...askModeAllowedTools]);
    isAskModeEnabled = true;
    updateAskModeStatus(isAskModeEnabled, ctx);
    persistAskModeState();

    ctx.ui.notify('Ask mode enabled. Only file reads are allowed.', 'info');
  }

  function disableAskMode(ctx: ExtensionContext): void {
    if (!isAskModeEnabled) {
      return;
    }

    pi.setActiveTools(toolsBeforeAskMode ?? pi.getActiveTools());
    isAskModeEnabled = false;
    toolsBeforeAskMode = undefined;
    updateAskModeStatus(isAskModeEnabled, ctx);
    persistAskModeState();

    ctx.ui.notify('Ask mode disabled. Tool access restored.', 'info');
  }

  function syncAskModeOnSessionEvent(ctx: ExtensionContext): void {
    const state = restoreAskModeState(ctx);
    isAskModeEnabled = state.isEnabled;
    toolsBeforeAskMode = state.toolsBeforeAskMode;

    if (isAskModeEnabled) {
      toolsBeforeAskMode ??= pi.getActiveTools();
      pi.setActiveTools([...askModeAllowedTools]);
    }

    updateAskModeStatus(isAskModeEnabled, ctx);
  }

  pi.registerCommand('ask', {
    description:
      'Toggle ask mode (read-only tool access). Usage: /ask [on|off|toggle|status]',
    async handler(args, ctx) {
      const command = parseAskCommandInput(args);

      if (command === 'status') {
        ctx.ui.notify(
          isAskModeEnabled
            ? 'Ask mode is currently enabled.'
            : 'Ask mode is currently disabled.',
          'info',
        );
        return;
      }

      if (command === 'on') {
        enableAskMode(ctx);
        return;
      }

      if (command === 'off') {
        disableAskMode(ctx);
        return;
      }

      if (isAskModeEnabled) {
        disableAskMode(ctx);
      } else {
        enableAskMode(ctx);
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
    syncAskModeOnSessionEvent(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    syncAskModeOnSessionEvent(ctx);
  });
}
