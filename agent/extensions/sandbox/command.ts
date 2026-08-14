import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import type {ConfigScope, ConfigStore} from './config.ts';
import type {SandboxSessionManager} from './session-manager.ts';

export class SandboxCommand {
  config: ConfigStore;
  sandbox: SandboxSessionManager;

  constructor(config: ConfigStore, sandbox: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  register(pi: ExtensionAPI): void {
    pi.registerCommand('sandbox', {
      description: 'Manage sandbox access.',
      handler: async (_args, ctx) => {
        const action = await ctx.ui.select('Sandbox', [
          'View access',
          'Allow a folder',
          'Allow a website',
          'Network-deny prompts',
        ]);
        if (action === undefined) {
          return;
        }

        try {
          if (action === 'View access') {
            await this.config.reload();
            await this.sandbox.restartSession();
            ctx.ui.notify(JSON.stringify(SandboxManager.getConfig(), undefined, 2), 'info');
            return;
          }

          const scope = await ctx.ui.select('Apply to', ['This project', 'All projects']);
          if (scope === undefined) {
            return;
          }

          const configScope: ConfigScope = scope === 'All projects' ? 'global' : 'project';
          if (action === 'Allow a folder') {
            const path = await ctx.ui.input('Folder path');
            if (path === undefined || path.trim().length === 0) {
              return;
            }

            const directory = this.config.resolveAllowedDirectory(path.trim());
            await this.config.addDirectory(configScope, directory);
            await this.sandbox.restartSession();
            ctx.ui.notify(`Sandbox allows ${directory}.`, 'info');
            return;
          }

          if (action === 'Allow a website') {
            const domain = await ctx.ui.input('Domain pattern (for example, api.example.com:443)');
            if (domain === undefined || domain.trim().length === 0) {
              return;
            }

            await this.config.addDomain(configScope, domain.trim());
            await this.sandbox.restartSession();
            ctx.ui.notify(`Sandbox allows ${domain.trim()}.`, 'info');
            return;
          }

          const prompts = await ctx.ui.select('Prompt when a website is blocked?', ['On', 'Off']);
          if (prompts === undefined) {
            return;
          }

          await this.config.setPrompting(configScope, prompts === 'On');
          await this.sandbox.restartSession();
          ctx.ui.notify(`Sandbox network-deny prompts are ${prompts.toLowerCase()}.`, 'info');
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        }
      },
    });
  }
}
