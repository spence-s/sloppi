import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import type {
  Config,
  ConfigScope,
  ConfigStore,
  FilesystemPermission,
  NetworkPermission,
} from './config.ts';
import type {SandboxSessionManager} from './session-manager.ts';

type RuleSelection = {
  effectiveEntries: string[];
  globalEntries: Set<string>;
  kind: 'filesystem' | 'network';
  projectEntries: Set<string>;
  scope: ConfigScope;
};

export class SandboxCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;

  constructor(config: ConfigStore, sandbox: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  async finish(ctx: ExtensionCommandContext, message: string): Promise<void> {
    await this.sandbox.restartSession();
    ctx.ui.notify(message, 'info');
  }

  async show(ctx: ExtensionCommandContext): Promise<void> {
    await this.config.reload();
    await this.sandbox.restartSession();
    ctx.ui.notify(JSON.stringify(SandboxManager.getConfig(), undefined, 2), 'info');
  }

  /** Lets the user configure scoped delegation or its global default model. */
  async manageResearchAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.load();
    const scopedSetting = this.config.getResearchAgentsSetting(scope);
    const action = await ctx.ui.select('Research agents', scope === 'global'
      ? [scopedSetting === true ? 'Turn off' : 'Turn on', 'Default model']
      : ['Turn on', 'Turn off', 'Use global setting']);
    if (action === undefined) {
      return;
    }

    if (action === 'Default model') {
      await this.manageResearchScoutModel(ctx);
      return;
    }

    await this.config.setResearchAgentsEnabled(scope, action === 'Use global setting' ? undefined : action === 'Turn on');
    const isNextEnabled = this.config.areResearchAgentsEnabled();
    const activeTools = pi.getActiveTools().filter(name => name !== 'research_scout');
    pi.setActiveTools(isNextEnabled ? [...activeTools, 'research_scout'] : activeTools);
    ctx.ui.notify(
      action === 'Use global setting'
        ? `Research agents now use the global setting and are ${isNextEnabled ? 'on' : 'off'}.`
        : `Research agents are ${action === 'Turn on' ? 'on' : 'off'} in ${scope} scope.`,
      'info',
    );
  }

  /** Lets the user select the default model for research profiles. */
  async manageResearchScoutModel(ctx: ExtensionCommandContext): Promise<void> {
    await this.config.load();
    const current = this.config.getResearchScoutModel();
    const models = ctx.modelRegistry.getAvailable();
    const choices = models.map(model => `${model.provider}/${model.id}`);
    const selection = await ctx.ui.select(
      `Research Scout model${current === undefined ? '' : ` (${current.provider}/${current.id})`}`,
      [...choices, 'Clear model'],
    );
    if (selection === undefined) {
      return;
    }

    if (selection === 'Clear model') {
      await this.config.setResearchScoutModel(undefined);
      ctx.ui.notify('Default Research Scout model cleared; profiles without their own model are disabled.', 'info');
      return;
    }

    const model = models[choices.indexOf(selection)];
    if (model === undefined) {
      throw new Error('Selected Research Scout model is unavailable.');
    }

    await this.config.setResearchScoutModel({provider: model.provider, id: model.id});
    ctx.ui.notify(`Research Scout will use ${model.provider}/${model.id}.`, 'info');
  }

  async edit(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.reload();
    const edited = await ctx.ui.editor(
      `Edit ${scope} SRT configuration`,
      JSON.stringify(this.config.getScopedSrtConfig(scope), undefined, 2),
    );
    if (edited === undefined) {
      return;
    }

    const parsed = JSON.parse(edited) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('SRT configuration must be a JSON object.');
    }

    const replacement: Config = Object.fromEntries(Object.entries(parsed));
    if ('projects' in replacement || 'sandbox' in replacement) {
      throw new Error('projects and sandbox are reserved Sloppi configuration keys.');
    }

    const isIsolationWeakened = replacement.allowAppleEvents === true
      || replacement.enableWeakerNestedSandbox === true
      || replacement.enableWeakerNetworkIsolation === true
      || replacement.filesystem?.disabled === true
      || replacement.network?.allowAllUnixSockets === true;
    if (isIsolationWeakened && !await ctx.ui.confirm(
      'Weaken sandbox isolation?',
      'This configuration enables an unrestricted or weaker SRT option.',
    )) {
      return;
    }

    await this.config.replaceSrtConfig(scope, replacement);
    await this.finish(ctx, `Updated ${scope} SRT configuration.`);
  }

  async selectRuleToRemove(ctx: ExtensionCommandContext, selection: RuleSelection): Promise<string | undefined> {
    const {effectiveEntries, globalEntries, kind, projectEntries, scope} = selection;
    const choices = effectiveEntries.map(entry => {
      const sources = [
        projectEntries.has(entry) ? 'project' : '',
        globalEntries.has(entry) ? 'global' : '',
      ].filter(Boolean);
      return `${entry} [${sources.length === 0 ? 'Sloppi default' : sources.join(', ')}]`;
    });
    if (choices.length === 0) {
      ctx.ui.notify(`No matching effective ${kind} rules.`, 'info');
      return undefined;
    }

    const choice = await ctx.ui.select(`Remove effective ${kind} rule`, choices);
    if (choice === undefined) {
      return undefined;
    }

    const entry = effectiveEntries[choices.indexOf(choice)];
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

  async manageFilesystem(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const action = await ctx.ui.select('Filesystem', ['Add rule', 'Remove rule']);
    if (action === undefined) {
      return;
    }

    const permission = await ctx.ui.select([
      'Permission',
      'Project and global path lists combine.',
      'Read: allowed by default; allow re-opens a denied parent, but a more-specific deny stays denied.',
      'Write: denied by default; allow opens a path, and deny exceptions win.',
    ].join('\n'), [
      'Allow read',
      'Allow write',
      'Allow read and write',
      'Deny read',
      'Deny write',
    ]);
    if (permission === undefined) {
      return;
    }

    let permissions: FilesystemPermission[];
    switch (permission) {
      case 'Allow read and write': {
        permissions = ['allowRead', 'allowWrite'];
        break;
      }

      case 'Allow read': {
        permissions = ['allowRead'];
        break;
      }

      case 'Allow write': {
        permissions = ['allowWrite'];
        break;
      }

      case 'Deny read': {
        permissions = ['denyRead'];
        break;
      }

      default: {
        permissions = ['denyWrite'];
      }
    }

    let path: string | undefined;
    if (action === 'Add rule') {
      path = await ctx.ui.input('SRT filesystem path or pattern');
    } else {
      await this.config.reload();
      const globalConfig = this.config.getScopedSrtConfig('global');
      const projectConfig = this.config.getScopedSrtConfig('project');
      const effectiveConfig = this.config.getEffectiveConfig();
      const runtimeConfig = SandboxManager.getConfig();
      const globalEntries = new Set(permissions.flatMap(key => globalConfig.filesystem?.[key] ?? []));
      const projectEntries = new Set(permissions.flatMap(key => projectConfig.filesystem?.[key] ?? []));
      const effectiveEntries = [...new Set(permissions.flatMap(key => [
        ...(effectiveConfig.filesystem?.[key] ?? []),
        ...(runtimeConfig?.filesystem?.[key] ?? []),
      ]))];
      path = await this.selectRuleToRemove(ctx, {
        effectiveEntries,
        globalEntries,
        kind: 'filesystem',
        projectEntries,
        scope,
      });
    }

    if (path === undefined || path.trim().length === 0) {
      return;
    }

    const listAction = action === 'Add rule' ? 'add' : 'remove';
    await this.config.updateFilesystem(scope, permissions, listAction, path.trim());
    await this.finish(ctx, `${listAction === 'add' ? 'Added' : 'Removed'} ${path.trim()} in ${scope} filesystem rules.`);
  }

  async manageNetwork(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const action = await ctx.ui.select('Network', ['Add rule', 'Remove rule']);
    if (action === undefined) {
      return;
    }

    const permissionChoice = await ctx.ui.select([
      'Rule',
      'Project and global domain lists combine.',
      'Network is denied by default; allow opens a domain, and deny is checked first and wins.',
    ].join('\n'), ['Allow domain', 'Deny domain']);
    if (permissionChoice === undefined) {
      return;
    }

    const permission: NetworkPermission = permissionChoice === 'Allow domain' ? 'allow' : 'deny';
    let domain: string | undefined;
    let reason: string | undefined;
    if (action === 'Add rule') {
      domain = await ctx.ui.input('SRT domain pattern (for example, api.example.com:443)');
      if (permission === 'deny' && domain !== undefined && domain.trim().length > 0) {
        reason = await ctx.ui.input('Optional denial reason shown to the model');
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
      domain = await this.selectRuleToRemove(ctx, {
        effectiveEntries,
        globalEntries,
        kind: 'network',
        projectEntries,
        scope,
      });
    }

    if (domain === undefined || domain.trim().length === 0) {
      return;
    }

    const normalizedReason = reason?.trim();
    const listAction = action === 'Add rule' ? 'add' : 'remove';
    await this.config.updateDomain(
      scope,
      permission,
      listAction,
      domain.trim(),
      normalizedReason === undefined || normalizedReason.length === 0 ? undefined : normalizedReason,
    );
    await this.finish(ctx, `${listAction === 'add' ? 'Added' : 'Removed'} ${domain.trim()} in ${scope} network rules.`);
  }

  register(pi: ExtensionAPI): void {
    pi.registerCommand('sandbox', {
      description: 'Manage project sandbox access; use /sandbox global for global access.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        if (argument !== '' && argument !== 'global') {
          ctx.ui.notify('Use /sandbox or /sandbox global.', 'error');
          return;
        }

        const scope: ConfigScope = argument === 'global' ? 'global' : 'project';
        try {
          const action = await ctx.ui.select(`Sandbox (${scope})`, [
            'View access',
            'Filesystem',
            'Network',
            'Advanced SRT options',
            'Network-deny prompts',
            'Research agents',
            'Reset configuration',
          ]);
          switch (action) {
            case 'View access': {
              await this.show(ctx);
              break;
            }

            case 'Filesystem': {
              await this.manageFilesystem(ctx, scope);
              break;
            }

            case 'Network': {
              await this.manageNetwork(ctx, scope);
              break;
            }

            case 'Advanced SRT options': {
              await this.edit(ctx, scope);
              break;
            }

            case 'Network-deny prompts': {
              const prompting = await ctx.ui.select('Prompt when a website is blocked?', ['On', 'Off']);
              if (prompting !== undefined) {
                await this.config.setPrompting(scope, prompting === 'On');
                await this.finish(ctx, `Sandbox network-deny prompts are ${prompting.toLowerCase()} in ${scope} scope.`);
              }

              break;
            }

            case 'Research agents': {
              await this.manageResearchAgents(pi, ctx, scope);
              break;
            }

            case 'Reset configuration': {
              if (await ctx.ui.confirm('Reset sandbox configuration?', `Remove every rule stored in ${scope} scope?`)) {
                await this.config.resetScope(scope);
                await this.finish(ctx, `Reset ${scope} sandbox configuration.`);
              }

              break;
            }

            case undefined: {
              break;
            }

            default: {
              break;
            }
          }
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
