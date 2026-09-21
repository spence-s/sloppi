import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent';
import {getKeybindings} from '@earendil-works/pi-tui';
import type {ConfigScope, ConfigStore} from '../config.ts';
import type {PlaywrightBridge} from '../playwright.ts';
import type {SandboxSessionManager} from '../session-manager.ts';
import {SandboxFilesystemCommand} from './filesystem.ts';
import {SandboxNetworkCommand} from './network.ts';
import {SandboxOptionsCommand} from './options.ts';

export class SandboxCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;
  filesystem: SandboxFilesystemCommand;
  network: SandboxNetworkCommand;
  options: SandboxOptionsCommand;

  /**
   Composes the option-specific commands behind the public /sandbox command.
   */
  constructor(config: ConfigStore, sandbox: SandboxSessionManager, playwright?: PlaywrightBridge) {
    this.config = config;
    this.sandbox = sandbox;
    this.filesystem = new SandboxFilesystemCommand(config, sandbox);
    this.network = new SandboxNetworkCommand(config, sandbox);
    this.options = new SandboxOptionsCommand(config, sandbox, playwright);
  }

  /**
   Keeps the settings browser open until Escape is pressed at its top level.
   */
  async manage(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<void> {
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
        await this.config.reload();
        const scopeLabel = activeScope === 'project' ? '󰉋 LOCAL · This project' : '󰖟 GLOBAL · All projects';
        const toggleAction = this.sandbox.isEnabled ? 'Turn off session protection' : 'Turn on session protection';
        const statusIcon = this.sandbox.isEnabled ? '󰕥' : '󰒲';
        const statusLabel = this.sandbox.isEnabled ? 'On' : 'Off';
        const title = `${statusIcon} Sandbox: ${statusLabel} — ${scopeLabel}`;
        const action = await ctx.ui.select(title, [
          'Filesystem Access',
          'Network Access',
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
            await this.options.setEnabled(ctx, !this.sandbox.isEnabled);
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
   Registers the interactive settings command and its non-interactive shortcuts.
   */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('sandbox', {
      description: 'Manage sandbox protection and access in plain language.',
      handler: async (rawArguments, ctx) => {
        const argument = rawArguments.trim();
        try {
          if (['on', 'off', 'toggle'].includes(argument)) {
            await this.options.setEnabled(ctx, argument === 'toggle' ? !this.sandbox.isEnabled : argument === 'on');
            return;
          }

          if (argument === 'status') {
            this.options.setStatus(ctx);
            ctx.ui.notify(`Sandbox is ${this.sandbox.isEnabled ? 'on' : 'off'} for this session.`, 'info');
            return;
          }

          if (argument !== '' && argument !== 'global') {
            ctx.ui.notify('Use /sandbox. Optional shortcuts are global, on, off, toggle, and status.', 'error');
            return;
          }

          await this.manage(ctx, argument === 'global' ? 'global' : 'project');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
