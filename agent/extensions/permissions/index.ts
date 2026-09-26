import {realpathSync} from 'node:fs';
import process from 'node:process';
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {PermissionCommand} from './command.ts';
import {
  PermissionConfig,
  type PermissionRule,
} from './config.ts';
import {findPermissionInvocations} from './parser.ts';

type PendingCommand = {
  additional: number;
  command: string;
  selectors: string[];
};

export class Permissions {
  config: PermissionConfig;
  pending: PendingCommand | undefined;
  pi: ExtensionAPI;
  runningStagedCommand: string | undefined;
  sessionApprovals = new Set<string>();
  stagedCommand: string | undefined;

  /** Creates one policy gate that remains independent from command execution. */
  constructor(pi: ExtensionAPI, config = new PermissionConfig(realpathSync(process.cwd()))) {
    this.pi = pi;
    this.config = config;
  }

  /** Resolves literal invocations and applies the strongest resulting action. */
  async check(command: string, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    await this.config.reload();
    const globalDenials = this.config.getScopedRules('global').filter(rule => rule.action === 'deny');
    const deniedSelectors = [...new Set(findPermissionInvocations(command, globalDenials)
      .flatMap(invocation => invocation.selectors))];
    if (deniedSelectors.length > 0) {
      return {
        block: true,
        reason: `Denied by global command permission policy (${deniedSelectors.join(', ')}).`,
      };
    }

    const rules = this.config.getEffectiveRules();
    const rulesByCommand = new Map(rules.map(rule => [rule.command, rule]));
    const matchedRules: PermissionRule[] = [];
    for (const invocation of findPermissionInvocations(command, rules)) {
      const selector = invocation.selectors.toSorted((left, right) => right.split(' ').length - left.split(' ').length).at(0);
      const rule = selector === undefined ? undefined : rulesByCommand.get(selector);
      if (rule !== undefined) {
        matchedRules.push(rule);
      }
    }

    const action = (['deny', 'stage', 'ask', 'allow'] as const)
      .find(candidate => matchedRules.some(rule => rule.action === candidate));
    if (action === undefined || action === 'allow') {
      return;
    }

    const selectors = [...new Set(matchedRules.filter(rule => rule.action === action).map(rule => rule.command))];
    if (action === 'deny') {
      return {
        block: true,
        reason: `Denied by command permission policy (${selectors.join(', ')}).`,
      };
    }

    if (action === 'stage') {
      if (this.pending === undefined) {
        this.pending = {additional: 0, command, selectors};
      } else {
        this.pending.additional += 1;
      }

      return {
        block: true,
        reason: `Blocked for host staging: ${command}\nMatched permission selector${selectors.length === 1 ? '' : 's'}: ${selectors.join(', ')}. The user must review and press Enter to run it.`,
        terminate: true,
      };
    }

    if (this.sessionApprovals.has(command)) {
      return;
    }

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Command permission required for ${selectors.join(', ')}, but no confirmation UI is available.`,
      };
    }

    const choice = await ctx.ui.select(
      `Command permission required (${selectors.join(', ')})\n\n${command}`,
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

  /** Hands the first blocked staged command to an empty editor after Pi settles. */
  settle(ctx: ExtensionContext): void {
    const {pending} = this;
    this.pending = undefined;
    this.stagedCommand = undefined;
    if (pending === undefined) {
      return;
    }

    const extra = pending.additional > 0
      ? ` ${pending.additional} additional host-routed command${pending.additional === 1 ? ' was' : 's were'} blocked; retry one at a time.`
      : '';
    if (ctx.ui.getEditorText() !== '') {
      ctx.ui.notify(`Host staging skipped because the editor contains user text. Blocked command: ${pending.command}.${extra}`, 'warning');
      return;
    }

    this.stagedCommand = pending.command;
    ctx.ui.setEditorText(`!${pending.command}`);
    ctx.ui.notify(`Host command staged for review (${pending.selectors.join(', ')}). Edit or delete it; press Enter only to run it.${extra}`, 'warning');
  }

  /** Registers the unified gate, staging handoff, continuation, and settings UI. */
  register(): void {
    const command = new PermissionCommand(this.config);
    command.register(this.pi);

    this.pi.on('tool_call', async (event, ctx) => {
      if (!isToolCallEventType('bash', event)) {
        return;
      }

      return this.check(event.input.command, ctx);
    });

    this.pi.on('agent_settled', (_event, ctx) => {
      this.settle(ctx);
    });

    this.pi.on('user_bash', event => {
      this.runningStagedCommand = event.command === this.stagedCommand ? event.command : undefined;
      this.stagedCommand = undefined;
    });

    this.pi.events.on('sloppi:user-bash-end', completedCommand => {
      if (completedCommand !== this.runningStagedCommand) {
        return;
      }

      this.runningStagedCommand = undefined;
      this.pi.sendMessage({
        customType: 'permissions-stage-continue',
        content: 'The reviewed host command has finished. Continue working on the current task using its result.',
        display: false,
      }, {triggerTurn: true});
    });

    this.pi.on('session_start', async (_event, ctx) => {
      this.pending = undefined;
      this.runningStagedCommand = undefined;
      this.sessionApprovals.clear();
      this.stagedCommand = undefined;
      try {
        await this.config.reload();
        command.setStatus(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    });

    this.pi.on('before_agent_start', async () => {
      await this.config.reload();
      if (this.config.getEffectiveRules().every(rule => rule.action !== 'stage')) {
        return;
      }

      return {
        message: {
          customType: 'permissions-stage-guidance',
          content: 'Call host-routed Bash commands one at a time. Matching calls stop the run and require the user to review and press Enter.',
          display: false,
        },
      };
    });
  }
}

/** Loads the unified literal command-permission extension. */
export default function permissionExtension(pi: ExtensionAPI): void {
  new Permissions(pi).register();
}
