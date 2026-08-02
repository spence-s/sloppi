import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

type SudoMode = 'deny' | 'ask' | 'allow';

const sudoModes: SudoMode[] = ['deny', 'ask', 'allow'];
const sudoStatusId = '0:sudo-gate';
const deniedMessage =
  'Sudo is not allowed by default. Try another approach that does not require elevated privileges. '
  + 'If sudo is necessary, ask the user to change the sudo mode with /sudo.';

export default function sudoGate(pi: ExtensionAPI): void {
  let mode: SudoMode = 'deny';

  const updateStatus = (ctx: ExtensionContext): void => {
    if (mode === 'deny') {
      ctx.ui.setStatus(sudoStatusId, ctx.ui.theme.fg('success', 'sudo: denied'));
      return;
    }

    if (mode === 'ask') {
      ctx.ui.setStatus(sudoStatusId, ctx.ui.theme.fg('warning', 'sudo: ask'));
      return;
    }

    ctx.ui.setStatus(sudoStatusId, ctx.ui.theme.fg('error', 'sudo: allowed'));
  };

  const setMode = (nextMode: SudoMode, ctx: ExtensionContext): void => {
    mode = nextMode;
    updateStatus(ctx);
    ctx.ui.notify(`Sudo mode set to ${mode}.`, 'info');
  };

  const deny = () => {
    pi.sendMessage(
      {
        customType: 'sudo-gate',
        content: deniedMessage,
        display: true,
      },
      {deliverAs: 'steer'},
    );

    return {
      block: true as const,
      reason: deniedMessage,
    };
  };

  pi.registerCommand('sudo', {
    description: 'Set the sudo policy. Usage: /sudo [deny|ask|allow|status]',
    async handler(args, ctx) {
      const requestedMode = args?.trim().toLowerCase();

      if (requestedMode === undefined || requestedMode.length === 0) {
        if (!ctx.hasUI) {
          ctx.ui.notify('/sudo requires UI or an explicit mode.', 'error');
          return;
        }

        const selectedMode = await ctx.ui.select('Sudo mode', sudoModes);
        const nextMode = sudoModes.find(candidate => candidate === selectedMode);
        if (nextMode !== undefined) {
          setMode(nextMode, ctx);
        }

        return;
      }

      const nextMode = sudoModes.find(candidate => candidate === requestedMode);
      if (nextMode !== undefined) {
        setMode(nextMode, ctx);
        return;
      }

      if (requestedMode === 'status') {
        ctx.ui.notify(`Sudo mode is ${mode}.`, 'info');
        return;
      }

      ctx.ui.notify('Usage: /sudo [deny|ask|allow|status]', 'error');
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event) || mode === 'allow') {
      return;
    }

    const hasSudo = event.input.command
      .split(/[\n\u{26}\u{28}\u{29}\u{3B}\u{60}\u{7B}\u{7C}\u{7D}]/v)
      .some(segment => segment.trimStart().split(/\s/v, 1)[0]?.split('/').at(-1) === 'sudo');

    if (!hasSudo) {
      return;
    }

    if (mode === 'deny' || !ctx.hasUI) {
      return deny();
    }

    const isAllowed = await ctx.ui.confirm(
      'Approve sudo tool call',
      `The bash command contains sudo:\n\n${event.input.command}\n\nAllow it once?`,
    );

    return isAllowed ? undefined : deny();
  });

  pi.on('session_start', async (_event, ctx) => {
    updateStatus(ctx);
  });
}
