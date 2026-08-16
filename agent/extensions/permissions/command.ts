import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type {
  PermissionConfig,
  PermissionScope,
} from './config.ts';

export class PermissionCommand {
  config: PermissionConfig;

  /** Creates the small policy editor used for deliberate persistent grants. */
  constructor(config: PermissionConfig) {
    this.config = config;
  }

  /** Edits only command decisions in the selected central policy scope. */
  async edit(ctx: ExtensionCommandContext, scope: PermissionScope): Promise<void> {
    await this.config.reload();
    const edited = await ctx.ui.editor(
      `Edit ${scope} command permissions`,
      JSON.stringify(this.config.getScopedCommands(scope), undefined, 2),
    );
    if (edited === undefined) {
      return;
    }

    await this.config.replaceCommands(scope, JSON.parse(edited) as unknown);
    const hasRules = Object.keys(this.config.getEffectiveCommands()).length > 0;
    ctx.ui.setStatus(
      'permissions',
      `${ctx.ui.theme.fg('warning', hasRules ? '󰌾' : '󰌿')} ${ctx.ui.theme.fg('muted', 'permissions')}`,
    );
    ctx.ui.notify(`Updated ${scope} command permissions.`, 'info');
  }

  /** Registers the project editor, with an explicit global-policy option. */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('permissions', {
      description: 'Edit project command permissions; use /permissions global for global policy.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        if (argument !== '' && argument !== 'global') {
          ctx.ui.notify('Use /permissions or /permissions global.', 'error');
          return;
        }

        try {
          await this.edit(ctx, argument === 'global' ? 'global' : 'project');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
