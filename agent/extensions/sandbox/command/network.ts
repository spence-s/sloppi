import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import type {ConfigScope, ConfigStore, NetworkPermission} from '../config.ts';
import type {SandboxSessionManager} from '../session-manager.ts';

type NetworkRuleSelection = {
  effectiveEntries: string[];
  globalEntries: Set<string>;
  projectEntries: Set<string>;
  scope: ConfigScope;
};

export class SandboxNetworkCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;

  /**
   Keeps scoped network rule workflows together.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  /**
   Prevents project menus from deleting inherited website settings.
   */
  private async selectNetworkRuleToRemove(ctx: ExtensionCommandContext, selection: NetworkRuleSelection): Promise<string | undefined> {
    const {effectiveEntries, globalEntries, projectEntries, scope} = selection;
    const entries = new Map(effectiveEntries.map(entry => {
      const sources = [
        projectEntries.has(entry) ? 'project' : '',
        globalEntries.has(entry) ? 'global' : '',
      ].filter(Boolean);
      return [`${entry} [${sources.length === 0 ? 'Sloppi default' : sources.join(', ')}]`, entry];
    }));
    if (entries.size === 0) {
      ctx.ui.notify('No matching website or service settings.', 'info');
      return undefined;
    }

    const scopeLabel = selection.scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const choice = await ctx.ui.select(`Remove website or service access — ${scopeLabel}`, entries.keys().toArray());
    if (choice === undefined) {
      return undefined;
    }

    const entry = entries.get(choice);
    const scopedEntries = scope === 'global' ? globalEntries : projectEntries;
    if (entry !== undefined && scopedEntries.has(entry)) {
      return entry;
    }

    const source = projectEntries.has(entry ?? '') ? 'project' : (globalEntries.has(entry ?? '') ? 'global' : 'Sloppi default');
    const command = source === 'global' ? '/sandbox global' : '/sandbox';
    ctx.ui.notify(
      source === 'Sloppi default'
        ? 'Sloppi default rules cannot be removed from configuration.'
        : `That rule belongs to ${source} scope. Use ${command} to remove it.`,
      'info',
    );
    return undefined;
  }

  /**
   Adds or removes network access without exposing SRT field names.
   */
  async manage(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const action = await ctx.ui.select(`Websites and services — ${scopeLabel}`, ['Add destination', 'Remove destination']);
    if (action === undefined) {
      return;
    }

    const permissionChoice = await ctx.ui.select(
      'What should happen?',
      ['Allow connections', 'Block connections'],
    );
    if (permissionChoice === undefined) {
      return;
    }

    const permission: NetworkPermission = permissionChoice === 'Allow connections' ? 'allow' : 'deny';
    let domain: string | undefined;
    let reason: string | undefined;
    if (action === 'Add destination') {
      domain = await ctx.ui.input('Website or service (for example, api.example.com:443)');
      if (permission === 'deny' && domain !== undefined && domain.trim().length > 0) {
        reason = await ctx.ui.input('What should Pi tell the model when this is blocked? (optional)');
      }
    } else {
      await this.config.reload();
      const globalConfig = this.config.getScopedSrtConfig('global');
      const projectConfig = this.config.getScopedSrtConfig('project');
      const effectiveConfig = this.config.getEffectiveConfig();
      const runtimeConfig = SandboxManager.getConfig();
      const key = permission === 'allow' ? 'allowedDomains' : 'deniedDomains';
      const globalEntries = new Set(globalConfig.network?.[key]);
      const projectEntries = new Set(projectConfig.network?.[key]);
      const effectiveEntries = [...new Set([
        ...(effectiveConfig.network?.[key] ?? []),
        ...(runtimeConfig?.network?.[key] ?? []),
      ])];
      domain = await this.selectNetworkRuleToRemove(ctx, {
        effectiveEntries,
        globalEntries,
        projectEntries,
        scope,
      });
    }

    const normalizedDomain = domain?.trim();
    if (normalizedDomain === undefined || normalizedDomain.length === 0) {
      return;
    }

    const normalizedReason = reason?.trim();
    const listAction = action === 'Add destination' ? 'add' : 'remove';
    await this.config.updateDomain(
      scope,
      permission,
      listAction,
      normalizedDomain,
      normalizedReason === undefined || normalizedReason.length === 0 ? undefined : normalizedReason,
    );
    await this.sandbox.restartSession();
    ctx.ui.notify(`${listAction === 'add' ? 'Added' : 'Removed'} ${normalizedDomain} in ${scope} network rules.`, 'info');
  }
}
