import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import type {ConfigStore} from '../config.ts';
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
}
