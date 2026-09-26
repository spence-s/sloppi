import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import type {
  PermissionAction,
  PermissionConfig,
  PermissionRule,
  PermissionScope,
} from './config.ts';

export class PermissionCommand {
  config: PermissionConfig;

  /** Creates the scoped settings browser for command policy. */
  constructor(config: PermissionConfig) {
    this.config = config;
  }

  /** Parses the optional semicolon-separated passthrough field shown by the TUI. */
  private parsePassthrough(value: string | undefined): string[] | undefined {
    const entries = value?.split(';').map(entry => entry.trim()).filter(Boolean) ?? [];
    return entries.length === 0 ? undefined : entries;
  }

  /** Asks for one of the four deliberately small permission actions. */
  private async selectAction(ctx: ExtensionCommandContext, title: string): Promise<PermissionAction | undefined> {
    const action = await ctx.ui.select(title, ['allow', 'ask', 'deny', 'stage']);
    if (action !== 'allow' && action !== 'ask' && action !== 'deny' && action !== 'stage') {
      return undefined;
    }

    return action;
  }

  /** Adds one literal command rule through short plain-language prompts. */
  private async add(ctx: ExtensionCommandContext, scope: PermissionScope): Promise<void> {
    const command = await ctx.ui.input(
      `Add a ${scope} command permission`,
      'Enter an executable and optional literal subcommand',
    );
    if (command === undefined) {
      return;
    }

    const action = await this.selectAction(ctx, `Choose what Pi should do with "${command.trim()}"`);
    if (action === undefined) {
      return;
    }

    const passthroughInput = await ctx.ui.input(
      `Exceptions for "${command.trim()}" — These exact argument sequences skip this rule`,
      'Separate exceptions with ; or leave blank for none',
    );
    if (passthroughInput === undefined) {
      return;
    }

    const passthrough = this.parsePassthrough(passthroughInput);
    await this.config.reload();
    await this.config.replaceRules(scope, [
      ...this.config.getScopedRules(scope),
      {action, command, ...(passthrough !== undefined && {passthrough})},
    ]);
    ctx.ui.notify(`Added ${command.trim()} as ${action} in ${scope} permissions.`, 'info');
  }

  /** Changes the outcome without changing the selector or its exceptions. */
  private async editAction(ctx: ExtensionCommandContext, scope: PermissionScope, rule: PermissionRule): Promise<void> {
    const action = await this.selectAction(ctx, `Permission for "${rule.command}" is ${rule.action}`);
    if (action === undefined) {
      return;
    }

    await this.config.reload();
    const rules = this.config.getScopedRules(scope).map(candidate => candidate.command === rule.command
      ? {...candidate, action}
      : candidate);
    await this.config.replaceRules(scope, rules);
    ctx.ui.notify(`Changed ${rule.command} to ${action}.`, 'info');
  }

  /** Edits argument exceptions while keeping command identity obvious. */
  private async editPassthrough(ctx: ExtensionCommandContext, scope: PermissionScope, rule: PermissionRule): Promise<void> {
    const current = rule.passthrough?.join('; ') ?? 'none';
    const value = await ctx.ui.input(
      `Edit exceptions for "${rule.command}" (currently: ${current})`,
      'Separate exact sequences with ; or leave blank for none',
    );
    if (value === undefined) {
      return;
    }

    const passthrough = this.parsePassthrough(value);
    await this.config.reload();
    const rules = this.config.getScopedRules(scope).map(candidate => candidate.command === rule.command
      ? {action: candidate.action, command: candidate.command, ...(passthrough !== undefined && {passthrough})}
      : candidate);
    await this.config.replaceRules(scope, rules);
    ctx.ui.notify(`Updated exceptions for ${rule.command}.`, 'info');
  }

  /** Removes one rule after explicit confirmation. */
  private async remove(ctx: ExtensionCommandContext, scope: PermissionScope, rule: PermissionRule): Promise<void> {
    if (!await ctx.ui.confirm(
      `Remove permission for "${rule.command}"?`,
      'The next matching rule, or the default allow behavior, will apply.',
    )) {
      return;
    }

    await this.config.reload();
    await this.config.replaceRules(
      scope,
      this.config.getScopedRules(scope).filter(candidate => candidate.command !== rule.command),
    );
    ctx.ui.notify(`Removed ${rule.command} from ${scope} permissions.`, 'info');
  }

  /** Keeps a compact command list open until the user presses Escape. */
  async manage(ctx: ExtensionCommandContext, scope: PermissionScope): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Command permission settings require interactive TUI mode.', 'error');
      return;
    }

    const keybindings = getKeybindings();
    const userBindings = keybindings.getUserBindings();
    keybindings.setUserBindings({
      ...userBindings,
      'tui.select.up': [...new Set([...keybindings.getKeys('tui.select.up'), 'k' as const])],
      'tui.select.down': [...new Set([...keybindings.getKeys('tui.select.down'), 'j' as const])],
    });

    try {
      let activeScope = scope;
      /* eslint-disable no-await-in-loop -- Each completed menu action must be visible on the next render. */
      while (true) {
        await this.config.reload();
        const globalRules = this.config.getScopedRules('global');
        const projectRules = this.config.getScopedRules('project');
        const visibleRules = activeScope === 'global'
          ? globalRules.map(rule => ({rule, scope: 'global' as const}))
          : [
            ...projectRules.map(rule => ({rule, scope: 'project' as const})),
            ...globalRules.map(rule => ({rule, scope: 'global' as const})),
          ];
        const labels = new Map(visibleRules.map(({rule, scope: ruleScope}) => {
          const source = ruleScope === 'global' ? '󰖟' : '󰉋';
          const passthrough = rule.passthrough === undefined ? '' : `  ·  except: ${rule.passthrough.join(', ')}`;
          return [`${source} ${rule.command}  ·  ${rule.action}${passthrough}`, {rule, scope: ruleScope}];
        }));
        const scopeLabel = activeScope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
        const switchScope = activeScope === 'project' ? '← Manage global commands' : '← Manage local commands';
        const action = await ctx.ui.select(
          `Command permissions — ${scopeLabel}`,
          [
            '+ Add a command permission',
            ...labels.keys(),
            '',
            switchScope,
          ],
        );
        if (action === undefined) {
          return;
        }

        if (action === switchScope) {
          activeScope = activeScope === 'project' ? 'global' : 'project';
          continue;
        }

        if (action === '+ Add a command permission') {
          await this.add(ctx, activeScope);
          continue;
        }

        const selected = labels.get(action);
        if (selected === undefined) {
          continue;
        }

        if (selected.scope !== activeScope) {
          activeScope = selected.scope;
          continue;
        }

        const ruleAction = await ctx.ui.select(
          `${selected.rule.command} is ${selected.rule.action}`,
          ['Change action', 'Edit exceptions', 'Remove this command'],
        );
        // eslint-disable-next-line unicorn/prefer-switch -- A switch inside this menu loop conflicts with no-break-in-nested-loop.
        if (ruleAction === 'Change action') {
          await this.editAction(ctx, activeScope, selected.rule);
        } else if (ruleAction === 'Edit exceptions') {
          await this.editPassthrough(ctx, activeScope, selected.rule);
        } else if (ruleAction === 'Remove this command') {
          await this.remove(ctx, activeScope, selected.rule);
        }
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      keybindings.setUserBindings(userBindings);
    }
  }

  /** Shows whether any command policy is currently active. */
  setStatus(ctx: ExtensionContext): void {
    const hasRules = this.config.getEffectiveRules().length > 0;
    ctx.ui.setStatus(
      'permissions',
      `${ctx.ui.theme.fg(hasRules ? 'warning' : 'dim', hasRules ? '󰌾' : '󰌿')} ${ctx.ui.theme.fg('muted', 'permissions')}`,
    );
  }

  /** Registers the scoped interactive settings browser. */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('permissions', {
      description: 'Manage allow, ask, deny, and stage rules for literal commands.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        if (argument !== '' && argument !== 'global') {
          ctx.ui.notify('Use /permissions or /permissions global.', 'error');
          return;
        }

        try {
          await this.manage(ctx, argument === 'global' ? 'global' : 'project');
          await this.config.reload();
          this.setStatus(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
