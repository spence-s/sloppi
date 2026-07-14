import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

const sensitivePathPatterns = [
  /^\/$/v, // root
  /^~\/?$/v, // home dir shorthand
  /^\.$/v, // current directory
  /^\.\.$/v, // parent directory
  /^\.git\/?/v,
  /^\.env(?:\.|$)/v,
  /^node_modules\/?/v,
  /^\/etc(?:\/|$)/v,
  /^\/usr(?:\/|$)/v,
  /^\/bin(?:\/|$)/v,
  /^\/sbin(?:\/|$)/v,
  /^\/System(?:\/|$)/v,
  /^\/Library(?:\/|$)/v,
];

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let previous = '';

  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote && previous !== '\\') {
        quote = undefined;
      } else {
        current += character;
      }

      previous = character;
      continue;
    }

    if ((character === '"' || character === "'") && previous !== '\\') {
      quote = character;
      previous = character;
      continue;
    }

    if (/\s/v.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }

      previous = character;
      continue;
    }

    current += character;
    previous = character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeTarget(raw: string): string {
  if (raw === '--') {
    return '';
  }

  const isSingleQuoted = raw.startsWith("'") && raw.endsWith("'");
  const isDoubleQuoted = raw.startsWith('"') && raw.endsWith('"');

  if ((isSingleQuoted || isDoubleQuoted) && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  return raw;
}

export function classifyDanger(command: string): string[] {
  const reasons: string[] = [];
  const tokens = tokenizeShellCommand(command);

  if (tokens.length === 0) {
    return reasons;
  }

  if (tokens.includes('sudo')) {
    reasons.push('uses sudo');
  }

  const rmIndex = tokens.findIndex(
    (token) => token === 'rm' || token.endsWith('/rm'),
  );

  if (rmIndex === -1) {
    return reasons;
  }

  const rmTokens = tokens.slice(rmIndex + 1);
  const hasRecursiveDelete = rmTokens.some(
    (token) =>
      token.startsWith('-') &&
      (token.includes('r') || token.includes('R') || token.includes('f')),
  );

  if (hasRecursiveDelete) {
    reasons.push('uses recursive/force rm flags');
  }

  const targets = rmTokens
    .filter((token) => !token.startsWith('-'))
    .map((token) => normalizeTarget(token))
    .filter((target) => target.length > 0);

  const sensitiveTargets = targets.filter((target) =>
    sensitivePathPatterns.some((pattern) => pattern.test(target)),
  );

  if (sensitiveTargets.length > 0) {
    reasons.push(`rm target looks sensitive (${sensitiveTargets.join(', ')})`);
  }

  return reasons;
}

export async function onToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | void> {
  if (!isToolCallEventType('bash', event)) {
    return;
  }

  const reasons = classifyDanger(event.input.command);
  if (reasons.length === 0) {
    return;
  }

  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `Blocked risky command in non-interactive mode: ${reasons.join('; ')}`,
    };
  }

  const reasonText = reasons.map((reason) => `• ${reason}`).join('\n');
  const message = `This bash command looks risky:\n\n${event.input.command}\n\n${reasonText}\n\nAllow it?`;

  const isAllowed = await ctx.ui.confirm('Approve risky tool call', message);
  if (!isAllowed) {
    return {block: true, reason: 'Blocked by extension approval gate'};
  }
}

export default function toolPermissionGate(pi: Pick<ExtensionAPI, 'on'>): void {
  pi.on('tool_call', onToolCall);
}
