import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import type {ConfigScope, ConfigStore} from '../config.ts';
import type {PlaywrightBridge} from '../playwright.ts';
import type {SandboxSessionManager} from '../session-manager.ts';
import {SandboxAdvancedCommand} from './advanced.ts';
import {SandboxFilesystemCommand} from './filesystem.ts';
import {SandboxNetworkCommand} from './network.ts';

export class SandboxCommand {
  sandbox: SandboxSessionManager;
  advanced: SandboxAdvancedCommand;
  filesystem: SandboxFilesystemCommand;
  network: SandboxNetworkCommand;
  playwright: PlaywrightBridge | undefined;

  /**
   Composes the scoped access and advanced settings screens behind the public
   `/sandbox` command while sharing one configuration and session manager.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager, playwright?: PlaywrightBridge) {
    this.sandbox = sandbox;
    this.advanced = new SandboxAdvancedCommand(config);
    this.filesystem = new SandboxFilesystemCommand(config, sandbox);
    this.network = new SandboxNetworkCommand(config, sandbox);
    this.playwright = playwright;
  }

  /**
   Shows the current tool-execution boundary in Pi's shared status area so
   command shortcuts and interactive changes report state consistently.
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
   Switches tool execution between SRT and the host for this session. Disabling
   protection requires confirmation and also closes the sandbox browser bridge.
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
   Keeps the settings browser open until Escape is pressed at its top level and
   carries the selected global or local scope into every child screen.
   */
  async manage(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
    const keybindings = getKeybindings();
    const userBindings = keybindings.getUserBindings();
    keybindings.setUserBindings({
      ...userBindings,
      'tui.select.up': [...new Set([...keybindings.getKeys('tui.select.up'), 'k' as const])],
      'tui.select.down': [...new Set([...keybindings.getKeys('tui.select.down'), 'j' as const])],
    });

    try {
      let activeScope = scope;
      /* eslint-disable no-await-in-loop, unicorn/no-break-in-nested-loop -- Each menu must finish before the next reflects its changes. */
      while (true) {
        const scopeLabel = activeScope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
        const toggleAction = this.sandbox.isEnabled ? 'Turn off session protection' : 'Turn on session protection';
        const statusIcon = this.sandbox.isEnabled ? '󰕥' : '󰒲';
        const statusLabel = this.sandbox.isEnabled ? 'On' : 'Off';
        const title = `${statusIcon} Sandbox: ${statusLabel} — ${scopeLabel}`;
        const action = await ctx.ui.select(title, [
          'Filesystem Access',
          'Network Access',
          'Advanced',
          toggleAction,
          '',
          activeScope === 'project' ? '← Manage global settings' : '← Manage local settings',
        ]);
        if (action === undefined) {
          return;
        }

        switch (action) {
          case 'Turn off session protection':
          case 'Turn on session protection': {
            await this.setEnabled(ctx, !this.sandbox.isEnabled);
            break;
          }

          case 'Filesystem Access': {
            await this.filesystem.manage(ctx, activeScope);
            break;
          }

          case 'Network Access': {
            await this.network.manage(ctx, activeScope);
            break;
          }

          case 'Advanced': {
            await this.advanced.manage(pi, ctx, activeScope);
            break;
          }

          case '← Manage global settings': {
            activeScope = 'global';
            break;
          }

          case '← Manage local settings': {
            activeScope = 'project';
            break;
          }

          default: {
            break;
          }
        }
      }
      /* eslint-enable no-await-in-loop, unicorn/no-break-in-nested-loop */
    } finally {
      keybindings.setUserBindings(userBindings);
    }
  }

  /**
   Registers the interactive settings command and its non-interactive session
   shortcuts, reporting configuration failures through Pi's notification UI.
   */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('sandbox', {
      description: 'Manage sandbox protection and access in plain language.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        try {
          if (['on', 'off', 'toggle'].includes(argument)) {
            await this.setEnabled(ctx, argument === 'toggle' ? !this.sandbox.isEnabled : argument === 'on');
            return;
          }

          if (argument === 'status') {
            this.setStatus(ctx);
            ctx.ui.notify(`Sandbox is ${this.sandbox.isEnabled ? 'on' : 'off'} for this session.`, 'info');
            return;
          }

          if (argument !== '' && argument !== 'global') {
            ctx.ui.notify('Use /sandbox. Optional shortcuts are global, on, off, toggle, and status.', 'error');
            return;
          }

          await this.manage(pi, ctx, argument === 'global' ? 'global' : 'project');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
