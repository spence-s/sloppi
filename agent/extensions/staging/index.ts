import {realpathSync} from 'node:fs';
import process from 'node:process';
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {StagingCommand} from './command.ts';
import {StagingConfig} from './config.ts';
import {findStagedInvocations} from './parser.ts';

type PendingCommand = {
  additional: number;
  command: string;
  selectors: string[];
};

export class Staging {
  config: StagingConfig;
  pending: PendingCommand | undefined;
  pi: ExtensionAPI;

  /** Creates an editor handoff that never executes host commands itself. */
  constructor(pi: ExtensionAPI, config = new StagingConfig(realpathSync(process.cwd()))) {
    this.pi = pi;
    this.config = config;
  }

  /** Blocks a configured literal invocation and asks Pi to settle without an abort error. */
  async check(command: string): Promise<ToolCallEventResult | void> {
    await this.config.reload();
    const invocations = findStagedInvocations(command, this.config.getEffectiveRules());
    if (invocations.length === 0) {
      return;
    }

    const selectors = [...new Set(invocations.flatMap(invocation => invocation.selectors))];
    if (this.pending === undefined) {
      this.pending = {additional: 0, command, selectors};
    } else {
      this.pending.additional += 1;
    }

    return {
      block: true,
      reason: `Blocked for host staging: ${command}\nMatched literal selector${selectors.length === 1 ? '' : 's'}: ${selectors.join(', ')}. The user must review and press Enter to run it.`,
      terminate: true,
    };
  }

  /** Hands the first blocked command to an empty editor after Pi fully settles. */
  settle(ctx: ExtensionContext): void {
    const {pending} = this;
    this.pending = undefined;
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

    ctx.ui.setEditorText(`!${pending.command}`);
    ctx.ui.notify(`Host command staged for review (${pending.selectors.join(', ')}). Edit or delete it; press Enter only to run it.${extra}`, 'warning');
  }

  /** Registers staging before execution and performs the editor handoff only after settlement. */
  register(): void {
    const command = new StagingCommand(this.config);
    command.register(this.pi);

    this.pi.on('tool_call', async event => {
      if (!isToolCallEventType('bash', event)) {
        return;
      }

      return this.check(event.input.command);
    });

    this.pi.on('agent_settled', (_event, ctx) => {
      this.settle(ctx);
    });

    this.pi.on('session_start', async (_event, ctx) => {
      this.pending = undefined;
      try {
        await this.config.reload();
        command.setStatus(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    });

    this.pi.on('before_agent_start', async () => {
      await this.config.reload();
      if (this.config.getEffectiveRules().length === 0) {
        return;
      }

      return {
        message: {
          customType: 'staging-guidance',
          content: 'Call host-routed Bash commands one at a time. Matching calls stop the run and require the user to review and press Enter.',
          display: false,
        },
      };
    });
  }
}

/** Loads the standalone host-command staging extension. */
export default function stagingExtension(pi: ExtensionAPI): void {
  new Staging(pi).register();
}
