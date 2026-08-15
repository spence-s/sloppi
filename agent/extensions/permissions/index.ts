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

  /** Applies configured command decisions and asks once for the complete shell expression. */
  async check(command: string, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    await this.config.reload();
    // ponytail: textual shell matching is a consent gate; add a shell parser only if bypass-resistant policy is required.
    const tokens = Array.from(command, character => ';&|()'.includes(character) ? ' ' : character)
      .join('')
      .split(/\s+/v);
    const matches = Object.entries(this.config.getEffectiveCommands()).filter(([executable]) => tokens.some(token => {
      const isQuoted = (token.startsWith('"') && token.endsWith('"'))
        || (token.startsWith('\'') && token.endsWith('\''));
      const normalized = isQuoted ? token.slice(1, -1) : token;
      return normalized === executable || normalized.endsWith(`/${executable}`);
    }));

    const denied = matches.find(([, decision]) => decision === 'deny');
    if (denied !== undefined) {
      return {block: true, reason: `${denied[0]} is denied by command permission policy.`};
    }

    const prompted = matches.filter(([, decision]) => decision === 'ask').map(([executable]) => executable);
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
      ['Allow once', 'Allow for this session', 'Deny'],
    );
    if (choice === 'Allow for this session') {
      this.sessionApprovals.add(command);
      return;
    }

    if (choice === 'Allow once') {
      return;
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
      ctx.ui.setStatus(
        'permissions',
        `${ctx.ui.theme.fg('warning', '󰌾')} ${ctx.ui.theme.fg('muted', 'permissions')}`,
      );
    });
  }
}

/** Loads the standalone command-permission extension. */
export default function permissionExtension(pi: ExtensionAPI): void {
  new Permissions(pi).register();
}
