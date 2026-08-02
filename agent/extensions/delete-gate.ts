import process from 'node:process';
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

// ponytail: regex heuristic; use filesystem sandboxing for a hard deletion boundary.
const destructivePattern = new RegExp(
  [
    // Shell commands.
    String.raw`\b(?:rm|rmdir)\b`,
    String.raw`\bfind\b.*\s-delete\b`,
    String.raw`\bgit\s+clean\b`,
    // Node.js filesystem APIs.
    String.raw`\b(?:fs(?:\.promises)?\s*\.\s*)?(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(`,
    // Python and Ruby filesystem APIs.
    String.raw`\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|File\.(?:delete|unlink)|FileUtils\.rm(?:_rf|_r|_f)|unlink|rmtree)\s*\(?`,
  ].join('|'),
  'sv',
);

const statusId = '1:delete-gate';

export default function deleteGate(pi: Pick<ExtensionAPI, 'on' | 'sendMessage' | 'registerCommand'>): void {
  let isEnabled = process.env.PI_DEV !== 'true';
  let hasDeniedDeletion = false;

  const updateStatus = (ctx: ExtensionContext): void => {
    const status = ctx.ui.theme.fg('dim', isEnabled ? 'delete: ask' : 'delete: allowed');
    ctx.ui.setStatus(statusId, status);
  };

  pi.registerCommand('delete', {
    description: 'Toggle file deletion confirmation. Usage: /delete [on|off|toggle|status]',
    async handler(args, ctx) {
      const requestedCommand = args?.trim().toLowerCase();
      const command = requestedCommand === '' || requestedCommand === undefined
        ? 'toggle'
        : requestedCommand;

      if (['on', 'off', 'toggle'].includes(command)) {
        isEnabled = command === 'toggle' ? !isEnabled : command === 'on';
        updateStatus(ctx);
        ctx.ui.notify(`File deletion confirmation ${isEnabled ? 'enabled' : 'disabled'}.`, 'info');
        return;
      }

      ctx.ui.notify(
        `File deletion confirmation is currently ${isEnabled ? 'enabled' : 'disabled'}.`,
        'info',
      );
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) {
      return;
    }

    const {command} = event.input;
    const isDeletion = destructivePattern.test(command);

    if (isDeletion && hasDeniedDeletion) {
      return {
        block: true,
        reason:
          'File deletion remains denied for this session. Obtain explicit new user approval before retrying.',
      };
    }

    if (!isEnabled || !isDeletion) {
      return;
    }

    const isAllowed =
      ctx.hasUI
      && (await ctx.ui.confirm(
        'Approve file deletion',
        `This bash command may delete files:\n\n${command}\n\nAllow it?`,
      ));

    if (isAllowed) {
      return;
    }

    if (isDeletion) {
      hasDeniedDeletion = true;
      pi.sendMessage(
        {
          customType: 'delete-gate',
          content:
            'The user denied file deletion. Do not retry it or use another command, script, interpreter, filesystem API, or workaround to achieve the same result. '
            + 'Ask for explicit new approval if deletion is still needed.',
          display: true,
        },
        {deliverAs: 'steer'},
      );
    }

    return {
      block: true,
      reason: ctx.hasUI
        ? 'Blocked by delete gate'
        : 'Blocked risky command in non-interactive mode',
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    updateStatus(ctx);
  });
}
