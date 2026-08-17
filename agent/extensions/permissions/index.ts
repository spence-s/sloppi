import {realpathSync} from 'node:fs';
import process from 'node:process';
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {PermissionCommand} from './command.ts';
import {PermissionConfig} from './config.ts';

export class Permissions {
  pi: ExtensionAPI;
  config: PermissionConfig;
  sessionApprovals = new Set<string>();

  /** Creates an intent gate that remains independent from command execution. */
  constructor(pi: ExtensionAPI, config = new PermissionConfig(realpathSync(process.cwd()))) {
    this.pi = pi;
    this.config = config;
  }

  /** Applies configured regex decisions and asks once for the complete shell expression. */
  async check(command: string, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    await this.config.reload();
    // ponytail: Regex matching is a consent gate; use a runtime broker if bypass-resistant policy becomes necessary.
    const matches = Object.entries(this.config.getEffectiveCommands())
      .filter(([pattern]) => new RegExp(pattern, 'v').test(command));

    const denied = matches.find(([, decision]) => decision === 'deny');
    if (denied !== undefined) {
      return {block: true, reason: `${denied[0]} is denied by command permission policy.`};
    }

    const prompted = matches.filter(([, decision]) => decision === 'ask').map(([pattern]) => pattern);
    if (prompted.length === 0 || this.sessionApprovals.has(command)) {
      return;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Command permission required for ${prompted.join(', ')}, but no confirmation UI is available.`,
      };
    }

    const choice = await ctx.ui.select(
      `Command permission required (${prompted.join(', ')})\n\n${command}`,
      ['Allow once', 'Allow for this session', 'Deny and steer…', 'Deny'],
    );
    if (choice === 'Allow for this session') {
      this.sessionApprovals.add(command);
      return;
    }

    if (choice === 'Allow once') {
      return;
    }

    if (choice === 'Deny and steer…') {
      const input = await ctx.ui.input('Steer the agent');
      const steering = input?.trim();
      if (steering !== undefined && steering.length > 0) {
        this.pi.sendUserMessage(steering, {deliverAs: 'steer'});
      }
    }

    return {block: true, reason: 'Command blocked by user.'};
  }

  /** Registers the bash preflight gate and its separate policy command. */
  register(): void {
    new PermissionCommand(this.config).register(this.pi);

    this.pi.on('tool_call', async (event, ctx) => {
      if (!isToolCallEventType('bash', event)) {
        return;
      }

      return this.check(event.input.command, ctx);
    });

    this.pi.on('session_start', async (_event, ctx) => {
      this.sessionApprovals.clear();
      await this.config.reload();
      const hasRules = Object.keys(this.config.getEffectiveCommands()).length > 0;
      ctx.ui.setStatus(
        'permissions',
        `${ctx.ui.theme.fg(hasRules ? 'warning' : 'dim', hasRules ? '󰌾' : '󰌿')} ${ctx.ui.theme.fg('muted', 'permissions')}`,
      );
    });
  }
}

/** Loads the standalone command-permission extension. */
export default function permissionExtension(pi: ExtensionAPI): void {
  new Permissions(pi).register();
}
