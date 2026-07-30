import process from 'node:process';
import {
  isToolCallEventType,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

// ponytail: regex heuristic; use filesystem sandboxing for a hard deletion boundary.
const destructivePattern =
  // eslint-disable-next-line @stylistic/max-len -- deletion patterns must remain one regex.
  /\b(?:rm|rmdir)\b|\bfind\b.*\s-delete\b|\bgit\s+clean\b|\b(?:fs(?:\.promises)?\s*\.\s*)?(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(|\b(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|File\.(?:delete|unlink)|FileUtils\.rm(?:_rf|_r|_f)|unlink|rmtree)\s*\(?/sv;

export default function toolPermissionGate(pi: Pick<ExtensionAPI, 'on' | 'sendMessage' | 'registerCommand'>): void {
  let isEnabled = process.env.PI_DEV !== 'true';
  let hasDeniedDeletion = false;

  pi.registerCommand('permissions', {
    description: 'Toggle risky bash command confirmation. Usage: /permissions [on|off|toggle|status]',
    async handler(args, ctx) {
      const requestedCommand = args?.trim().toLowerCase();
      const command = requestedCommand === '' || requestedCommand === undefined
        ? 'toggle'
        : requestedCommand;

      if (['on', 'off', 'toggle'].includes(command)) {
        isEnabled = command === 'toggle' ? !isEnabled : command === 'on';
        ctx.ui.notify(`Risky bash command confirmation ${isEnabled ? 'enabled' : 'disabled'}.`, 'info');
        return;
      }

      ctx.ui.notify(
        `Risky bash command confirmation is currently ${isEnabled ? 'enabled' : 'disabled'}.`,
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
    const isRisky = isDeletion || /\bsudo\b/v.test(command);

    if (isDeletion && hasDeniedDeletion) {
      return {
        block: true,
        reason:
          'File deletion remains denied for this session. Obtain explicit new user approval before retrying.',
      };
    }

    if (!isEnabled || !isRisky) {
      return;
    }

    const isAllowed =
      ctx.hasUI
      && (await ctx.ui.confirm(
        'Approve risky tool call',
        `This bash command may ${isDeletion ? 'delete files' : 'use sudo'}:\n\n${command}\n\nAllow it?`,
      ));

    if (isAllowed) {
      return;
    }

    if (isDeletion) {
      hasDeniedDeletion = true;
      pi.sendMessage(
        {
          customType: 'tool-permission-gate',
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
        ? 'Blocked by extension approval gate'
        : 'Blocked risky command in non-interactive mode',
    };
  });
}
