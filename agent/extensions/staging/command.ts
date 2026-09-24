import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import type {StagingConfig, StagingRule, StagingScope} from './config.ts';

export class StagingCommand {
  config: StagingConfig;

  /** Creates the small settings browser for host-command routing. */
  constructor(config: StagingConfig) {
    this.config = config;
  }

  /** Parses the optional semicolon-separated passthrough field shown by the TUI. */
  private parsePassthrough(value: string | undefined): string[] | undefined {
    const entries = value?.split(';').map(entry => entry.trim()).filter(Boolean) ?? [];
    return entries.length === 0 ? undefined : entries;
  }

  /** Adds one command rule through two short, plain-language prompts. */
  private async add(ctx: ExtensionCommandContext, scope: StagingScope): Promise<void> {
    const command = await ctx.ui.input(
      `Stage a ${scope} command — Matching agent Bash calls will pause for your review`,
      'Enter an executable and optional literal subcommand',
    );
    if (command === undefined) {
      return;
    }

    const passthroughInput = await ctx.ui.input(
      `Sandbox exceptions for "${command.trim()}" — These exact argument sequences will not be staged`,
      'Separate exceptions with ; or leave blank for none',
    );
    if (passthroughInput === undefined) {
      return;
    }

    const passthrough = this.parsePassthrough(passthroughInput);
    await this.config.reload();
    await this.config.replaceRules(scope, [
      ...this.config.getScopedRules(scope),
      {command, ...(passthrough !== undefined && {passthrough})},
    ]);
    ctx.ui.notify(`Added ${command.trim()} to ${scope} host staging.`, 'info');
  }

  /** Edits only the passthroughs so command identity stays obvious. */
  private async editPassthrough(ctx: ExtensionCommandContext, scope: StagingScope, rule: StagingRule): Promise<void> {
    const current = rule.passthrough?.join('; ') ?? 'none';
    const value = await ctx.ui.input(
      `Edit sandbox exceptions for "${rule.command}" — Matching arguments stay sandboxed (currently: ${current})`,
      'Separate exact sequences with ; or leave blank for none',
    );
    if (value === undefined) {
      return;
    }

    const passthrough = this.parsePassthrough(value);
    await this.config.reload();
    const rules = this.config.getScopedRules(scope).map(candidate => candidate.command === rule.command
      ? {command: candidate.command, ...(passthrough !== undefined && {passthrough})}
      : candidate);
    await this.config.replaceRules(scope, rules);
    ctx.ui.notify(`Updated passthroughs for ${rule.command}.`, 'info');
  }

  /** Removes one rule after an explicit confirmation. */
  private async remove(ctx: ExtensionCommandContext, scope: StagingScope, rule: StagingRule): Promise<void> {
    if (!await ctx.ui.confirm(
      `Stop staging "${rule.command}"?`,
      'Matching agent Bash calls will run in the sandbox without host review.',
    )) {
      return;
    }

    await this.config.reload();
    await this.config.replaceRules(
      scope,
      this.config.getScopedRules(scope).filter(candidate => candidate.command !== rule.command),
    );
    ctx.ui.notify(`Removed ${rule.command} from ${scope} host staging.`, 'info');
  }

  /** Keeps a compact command list open until the user presses Escape. */
  async manage(ctx: ExtensionCommandContext, scope: StagingScope): Promise<void> {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Host-command staging settings require interactive TUI mode.', 'error');
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
          const passthrough = rule.passthrough?.length === undefined
            ? ''
            : `  ·  sandbox: ${rule.passthrough.join(', ')}`;
          return [`${source} ${rule.command}${passthrough}`, {rule, scope: ruleScope}];
        }));
        const scopeLabel = activeScope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
        const switchScope = activeScope === 'project' ? '← Manage global commands' : '← Manage local commands';
        const action = await ctx.ui.select(
          `Host-command staging — ${scopeLabel} — Matching agent Bash calls pause for host review`,
          [
            '+ Stage a command for host review',
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

        if (action === '+ Stage a command for host review') {
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
          `Staged command "${selected.rule.command}" — Choose how to change host review`,
          [
            'Edit sandbox exceptions',
            'Stop staging this command',
          ],
        );
        if (ruleAction === 'Edit sandbox exceptions') {
          await this.editPassthrough(ctx, activeScope, selected.rule);
        } else if (ruleAction === 'Stop staging this command') {
          await this.remove(ctx, activeScope, selected.rule);
        }
      }
      /* eslint-enable no-await-in-loop */
    } finally {
      keybindings.setUserBindings(userBindings);
    }
  }

  /** Shows whether any rule can currently route a Bash call to review. */
  setStatus(ctx: ExtensionContext): void {
    const hasRules = this.config.getEffectiveRules().length > 0;
    ctx.ui.setStatus(
      'staging',
      `${ctx.ui.theme.fg(hasRules ? 'warning' : 'dim', hasRules ? '󰏫' : '󰏬')} ${ctx.ui.theme.fg('muted', 'staging')}`,
    );
  }

  /** Registers the scoped interactive settings browser. */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('staging', {
      description: 'Manage commands staged for reviewed host execution.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        if (argument !== '' && argument !== 'global') {
          ctx.ui.notify('Use /staging or /staging global.', 'error');
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
