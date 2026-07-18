import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

const planTools = ['read', 'grep', 'find', 'ls', 'rg'];

export default function planMode(pi: ExtensionAPI): void {
  let isEnabled = false;
  let savedTools: string[] | undefined;

  function toggle(ctx: ExtensionContext): void {
    isEnabled = !isEnabled;

    if (isEnabled) {
      savedTools = pi.getActiveTools();
      pi.setActiveTools(planTools);
      ctx.ui.notify('Plan mode enabled. Read-only tools available.', 'info');
      return;
    }

    pi.setActiveTools(savedTools ?? pi.getActiveTools());
    savedTools = undefined;
    ctx.ui.notify('Plan mode disabled. Tool access restored.', 'info');
  }

  pi.registerCommand('plan', {
    description: 'Toggle read-only plan mode',
    async handler(_args, ctx) {
      toggle(ctx);
    },
  });

  pi.on('before_agent_start', (event) => {
    if (!isEnabled) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\nPlan mode active. Inspect only. Do not modify files, run commands, or claim changes were made. End with concise numbered plan.`,
    };
  });

  // ponytail: state resets on reload/session switch; persist only if resuming plans becomes necessary.
}
