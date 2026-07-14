type ToolCallEvent = {
  toolName?: string;
  input?: {
    command?: unknown;
  };
};

type ToolCallContext = {
  hasUI?: boolean;
  ui?: {
    confirm: (title: string, message: string) => Promise<boolean>;
  };
};

type ToolCallHandlerResult = void | {
  block: true;
  reason: string;
};

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ToolCallContext,
) => Promise<ToolCallHandlerResult>;

type PiExtensionApi = {
  on: (eventName: 'tool_call', handler: ToolCallHandler) => void;
};

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

  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote && previous !== '\\') {
        quote = undefined;
      } else {
        current += ch;
      }

      previous = ch;
      continue;
    }

    if ((ch === '"' || ch === "'") && previous !== '\\') {
      quote = ch;
      previous = ch;
      continue;
    }

    if (/\s/v.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }

      previous = ch;
      continue;
    }

    current += ch;
    previous = ch;
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

function classifyDanger(command: string): string[] {
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
  if (rmIndex !== -1) {
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
      reasons.push(
        `rm target looks sensitive (${sensitiveTargets.join(', ')})`,
      );
    }
  }

  return reasons;
}

export default function toolPermissionGate(pi: PiExtensionApi): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') {
      return;
    }

    const commandInput = event.input?.command;
    const command = typeof commandInput === 'string' ? commandInput : '';
    const reasons = classifyDanger(command);
    if (reasons.length === 0) {
      return;
    }

    if (ctx.hasUI !== true || ctx.ui === undefined) {
      return {
        block: true,
        reason: `Blocked risky command in non-interactive mode: ${reasons.join('; ')}`,
      };
    }

    const reasonText = reasons.map((reason) => `• ${reason}`).join('\n');
    const message = `This bash command looks risky:\n\n${command}\n\n${reasonText}\n\nAllow it?`;

    const isAllowed = await ctx.ui.confirm('Approve risky tool call', message);
    if (!isAllowed) {
      return {block: true, reason: 'Blocked by extension approval gate'};
    }
  });
}
