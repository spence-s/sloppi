import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import type {ConfigScope, ConfigStore} from '../config.ts';
import type {PlaywrightBridge} from '../playwright.ts';
import type {SandboxSessionManager} from '../session-manager.ts';

export class SandboxOptionsCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;
  playwright: PlaywrightBridge | undefined;

  /**
   Keeps session protection and non-access-list settings together.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager, playwright?: PlaywrightBridge) {
    this.config = config;
    this.sandbox = sandbox;
    this.playwright = playwright;
  }

  /**
   Lets the user select the default model for research profiles.
   */
  private async manageResearchScoutModel(ctx: ExtensionCommandContext): Promise<void> {
    await this.config.load();
    const current = this.config.getResearchScoutModel();
    const models = new Map(ctx.modelRegistry.getAvailable().map(model => [`${model.provider}/${model.id}`, model]));
    const selection = await ctx.ui.select(
      `Research Scout model — 󰖟 GLOBAL${current === undefined ? '' : ` (${current.provider}/${current.id})`}`,
      [...models.keys(), 'Clear model'],
    );
    if (selection === undefined) {
      return;
    }

    if (selection === 'Clear model') {
      await this.config.setResearchScoutModel(undefined);
      ctx.ui.notify('Default Research Scout model cleared; profiles without their own model are disabled.', 'info');
      return;
    }

    const model = models.get(selection);
    if (model === undefined) {
      throw new Error('Selected Research Scout model is unavailable.');
    }

    await this.config.setResearchScoutModel({provider: model.provider, id: model.id});
    ctx.ui.notify(`Research Scout will use ${model.provider}/${model.id}.`, 'info');
  }

  /**
   Shows the current tool-execution boundary in Pi's shared status area.
   */
  setStatus(ctx: ExtensionCommandContext): void {
    ctx.ui.setStatus(
      'sandbox',
      this.sandbox.isEnabled
        ? `${ctx.ui.theme.bold(ctx.ui.theme.fg('success', '󰕥'))} ${ctx.ui.theme.fg('muted', 'sandbox')}`
        : `${ctx.ui.theme.bold(ctx.ui.theme.fg('warning', '󰒲'))} ${ctx.ui.theme.fg('warning', 'sandbox off')}`,
    );
  }

  /**
   Switches tool execution between SRT and the host for this session.
   */
  async setEnabled(ctx: ExtensionCommandContext, isEnabled: boolean): Promise<void> {
    if (isEnabled === this.sandbox.isEnabled) {
      ctx.ui.notify(`Sandbox is already ${isEnabled ? 'on' : 'off'}.`, 'info');
      return;
    }

    if (!isEnabled && !await ctx.ui.confirm(
      'Turn off session protection?',
      'Are you sure? All tool calls will execute directly on the host with your user permissions for this session.',
    )) {
      return;
    }

    await this.sandbox.setEnabled(isEnabled);
    if (!isEnabled) {
      await this.playwright?.stop();
    }

    this.setStatus(ctx);
    ctx.ui.notify(`Sandbox is ${isEnabled ? 'on' : 'off'} for this session.`, isEnabled ? 'info' : 'warning');
  }

  /**
   Lets the user configure whether blocked websites trigger an approval prompt.
   */
  async managePrompting(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const scopeName = scope === 'project' ? 'This project' : 'Global defaults';
    const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const prompting = await ctx.ui.select(`Ask when a website is blocked? — ${scopeLabel}`, ['On', 'Off']);
    if (prompting === undefined) {
      return;
    }

    await this.config.setPrompting(scope, prompting === 'On');
    await this.sandbox.restartSession();
    ctx.ui.notify(`Blocked-website prompts are ${prompting.toLowerCase()} for ${scopeName.toLowerCase()}.`, 'info');
  }

  /**
   Lets the user configure scoped delegation or its global default model.
   */
  async manageResearchAgents(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    await this.config.load();
    const scopedSetting = this.config.getResearchAgentsSetting(scope);
    const scopeLabel = scope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
    const action = await ctx.ui.select(`Research agents — ${scopeLabel}`, scope === 'global'
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
}
