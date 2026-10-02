import {Buffer} from 'node:buffer';
import {type ExtensionAPI, type ExtensionCommandContext, readStoredCredential} from '@earendil-works/pi-coding-agent';
import {z} from 'zod';

const numberOrStringSchema = z.union([z.number(), z.string()]);
const usageWindowSchema = z.object({
  used_percent: z.number().nullable().optional(),
  limit_window_seconds: z.number().nullable().optional(),
  reset_after_seconds: z.number().nullable().optional(),
  reset_at: z.number().nullable().optional(),
});

const openAiUsageSchema = z.object({
  plan_type: z.string().nullable().optional(),
  rate_limit: z.object({
    allowed: z.boolean().nullable().optional(),
    limit_reached: z.boolean().nullable().optional(),
    primary_window: usageWindowSchema.nullable().optional(),
    secondary_window: usageWindowSchema.nullable().optional(),
  }).nullable().optional(),
  credits: z.object({
    has_credits: z.boolean().nullable().optional(),
    unlimited: z.boolean().nullable().optional(),
    balance: numberOrStringSchema.nullable().optional(),
  }).nullable().optional(),
});

const quotaValueSchema = numberOrStringSchema.nullable().optional();
const copilotQuotaSchema = z.object({
  entitlement: quotaValueSchema,
  remaining: quotaValueSchema,
  percent_remaining: quotaValueSchema,
  unlimited: z.boolean().nullable().optional(),
  has_quota: z.boolean().nullable().optional(),
  overage_count: quotaValueSchema,
  overage_permitted: z.boolean().nullable().optional(),
});

const copilotUsageSchema = z.object({
  copilot_plan: z.string().nullable().optional(),
  quota_reset_date: z.string().nullable().optional(),
  quota_reset_date_utc: z.string().nullable().optional(),
  quota_snapshots: z.record(z.string(), copilotQuotaSchema).nullable().optional(),
});

const openAiClaimsSchema = z.object({
  'https://api.openai.com/auth': z.object({
    chatgpt_account_id: z.string(),
  }),
});

type UsageWindow = z.infer<typeof usageWindowSchema>;
type CopilotQuota = z.infer<typeof copilotQuotaSchema>;

const copilotQuotaLabels: Readonly<Record<string, string>> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat messages',
  completions: 'Code completions',
};

/**
 Formats a provider or plan identifier for compact human-readable output.
 Provider APIs generally return lowercase machine names, while unknown future
 values should still remain visible instead of being discarded.
 */
function titleCase(value: string): string {
  return value.replaceAll(/(?:-|_)+/gv, ' ').replaceAll(/\b\w/gv, character => character.toUpperCase());
}

/**
 Converts an uncertain numeric quota field into a finite number. Copilot has
 returned both JSON numbers and numeric strings across client versions, so the
 formatter accepts both while rejecting empty and non-finite values.
 */
function numericValue(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }

  if (value === '') {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 Describes a future reset relative to the fetch time without introducing a
 date library. Days, hours, and minutes are enough precision for provider
 quota windows and keep the command output compact.
 */
function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes === 0) {
    return 'now';
  }

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  return [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', remainingMinutes > 0 ? `${remainingMinutes}m` : '']
    .filter(Boolean)
    .join(' ');
}

/**
 Renders a reset timestamp in UTC and includes a relative countdown. UTC keeps
 the value unambiguous in logs while the countdown makes the remaining wait
 immediately useful.
 */
function formatReset(timestamp: number, now: number): string {
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? 'Unknown' : `${date.toISOString().replace('.000Z', 'Z')} (in ${formatDuration(milliseconds - now)})`;
}

/**
 Formats one OpenAI quota window. The API's primary and secondary positions
 vary by plan, so the caller supplies a duration-derived label rather than
 assuming that position always means five-hour or weekly usage.
 */
function formatOpenAiWindow(label: string, window: UsageWindow, now: number): string[] {
  const used = Math.min(100, Math.max(0, window.used_percent ?? 0));
  const resetAt = window.reset_at ?? (window.reset_after_seconds === null || window.reset_after_seconds === undefined
    ? undefined
    : (now + (window.reset_after_seconds * 1000)) / 1000);

  return [
    `  ${label}`,
    `    Used: ${used.toFixed(1)}%  •  Left: ${(100 - used).toFixed(1)}%`,
    `    Resets: ${resetAt === undefined ? 'Unknown' : formatReset(resetAt, now)}`,
  ];
}

/**
 Validates and formats OpenAI Codex subscription usage. Window durations, not
 response positions, identify the requested five-hour and weekly limits so
 weekly-only plans are not mislabeled.
 */
export function formatOpenAiUsage(payload: unknown, now = Date.now()): string[] {
  const parsed = openAiUsageSchema.safeParse(payload);
  if (!parsed.success) {
    return ['OPENAI', '  Unavailable: OpenAI returned an unrecognized usage response.'];
  }

  const usage = parsed.data;
  const rateLimit = usage.rate_limit;
  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(window => window !== null && window !== undefined);
  const fiveHour = windows.find(window => window.limit_window_seconds === 18_000);
  const weekly = windows.find(window => window.limit_window_seconds === 604_800);
  let credits = '  Credits: Not reported';
  if (usage.credits?.unlimited === true) {
    credits = '  Credits: Unlimited';
  } else if (usage.credits?.has_credits === true) {
    credits = `  Credits left: ${usage.credits.balance ?? 'Unknown'}`;
  } else if (usage.credits !== null && usage.credits !== undefined) {
    credits = '  Credits: None';
  }

  const plan = typeof usage.plan_type === 'string' && usage.plan_type.length > 0 ? titleCase(usage.plan_type) : 'Unknown';
  let status = 'Unknown';
  if (rateLimit?.allowed === false || rateLimit?.limit_reached === true) {
    status = 'Limit reached';
  } else if (rateLimit?.allowed === true || rateLimit?.limit_reached === false) {
    status = 'Available';
  }

  return [
    'OPENAI',
    `  Plan: ${plan}`,
    `  Status: ${status}`,
    ...(fiveHour ? formatOpenAiWindow('5-hour window', fiveHour, now) : ['  5-hour window: Not reported by this plan.']),
    ...(weekly ? formatOpenAiWindow('Weekly window', weekly, now) : ['  Weekly window: Not reported by this plan.']),
    credits,
  ];
}

/**
 Formats one Copilot quota bucket, including overage state because zero
 included quota does not mean Copilot is blocked when paid overages are
 enabled.
 */
function formatCopilotQuota(label: string, quota: CopilotQuota): string[] {
  if (quota.has_quota === false) {
    return [`  ${label}: Not included in this plan.`];
  }

  if (quota.unlimited === true) {
    return [`  ${label}: Unlimited`];
  }

  const entitlement = numericValue(quota.entitlement);
  const remaining = numericValue(quota.remaining);
  const reportedPercent = numericValue(quota.percent_remaining);
  const percent = reportedPercent ?? (remaining !== undefined && entitlement !== undefined && entitlement > 0 ? (remaining / entitlement) * 100 : undefined);
  const count = remaining === undefined || entitlement === undefined ? '' : ` (${remaining.toLocaleString('en-US')} / ${entitlement.toLocaleString('en-US')})`;
  const lines = [`  ${label}: ${percent === undefined ? 'Unknown' : `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`}${count} left`];

  const overageCount = numericValue(quota.overage_count) ?? 0;
  if (quota.overage_permitted === true || overageCount > 0) {
    lines.push(`    Additional usage: ${quota.overage_permitted === true ? 'Enabled' : 'Disabled'}  •  Used: ${overageCount.toLocaleString('en-US')}`);
  }

  return lines;
}

/**
 Validates and formats GitHub Copilot's monthly quota snapshot. Known buckets
 appear in a stable useful order, while future buckets are retained afterward
 so the command remains informative if GitHub expands the response.
 */
export function formatCopilotUsage(payload: unknown, now = Date.now()): string[] {
  const parsed = copilotUsageSchema.safeParse(payload);
  if (!parsed.success) {
    return ['GITHUB COPILOT', '  Unavailable: GitHub returned an unrecognized usage response.'];
  }

  const usage = parsed.data;
  const quotas = usage.quota_snapshots ?? {};
  const knownKeys = Object.keys(copilotQuotaLabels);
  const keys = [...knownKeys.filter(key => quotas[key] !== undefined), ...Object.keys(quotas).filter(key => !knownKeys.includes(key))];
  const plan = typeof usage.copilot_plan === 'string' && usage.copilot_plan.length > 0 ? titleCase(usage.copilot_plan) : 'Unknown';
  const lines = [
    'GITHUB COPILOT',
    `  Plan: ${plan}`,
  ];

  if (keys.length === 0) {
    lines.push('  Quotas: No quota details were reported.');
  } else {
    for (const key of keys) {
      const quota = quotas[key];
      if (quota !== undefined) {
        lines.push(...formatCopilotQuota(copilotQuotaLabels[key] ?? titleCase(key), quota));
      }
    }
  }

  const reset = usage.quota_reset_date_utc ?? usage.quota_reset_date;
  lines.push(`  Monthly reset: ${typeof reset === 'string' && reset.length > 0 ? formatReset(Date.parse(reset), now) : 'Unknown'}`);
  return lines;
}

/**
 Extracts the ChatGPT account identifier from OpenAI's access-token claims as
 a fallback for older stored credentials that predate Pi's accountId field.
 Invalid or opaque tokens simply return undefined and never expose token data.
 */
function accountIdFromToken(token: string): string | undefined {
  try {
    const payload = token.split('.', 2)[1];
    if (payload === undefined || payload.length === 0) {
      return undefined;
    }

    const claims = openAiClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
    return claims.success ? claims.data['https://api.openai.com/auth'].chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 Resolves the legacy OpenAI Codex registry to the account-scoped OAuth values
 accepted by ChatGPT's usage endpoint. The current `openai` registry is not
 passed here because its token is explicitly scoped to `api.openai.com` and
 must never be forwarded to a different origin.
 */
async function resolveOpenAiUsageAuth(ctx: ExtensionCommandContext): Promise<{token: string; accountId?: string} | undefined> {
  try {
    const auth = await ctx.modelRegistry.getProviderAuth('openai-codex');
    const credential = readStoredCredential('openai-codex');
    const token = auth?.auth.apiKey;
    const storedAccountId = credential?.type === 'oauth' && typeof credential.accountId === 'string' ? credential.accountId : undefined;
    const accountId = storedAccountId ?? (token === undefined || token.length === 0 ? undefined : accountIdFromToken(token));
    if (token === undefined || credential?.type !== 'oauth' || token.length === 0) {
      return undefined;
    }

    return accountId === undefined || accountId.length === 0 ? {token} : {token, accountId};
  } catch {
    return undefined;
  }
}

/**
 Sends the read-only quota request with a legacy Codex login intended for the
 ChatGPT origin. Redirects are rejected so the bearer token cannot be forwarded
 if the fixed provider endpoint is ever redirected to another location.
 */
async function requestOpenAiUsage(resolved: {token: string; accountId?: string}): Promise<Response> {
  return fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${resolved.token}`,
      ...(resolved.accountId !== undefined && {'ChatGPT-Account-Id': resolved.accountId}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 Fetches OpenAI quota usage without crossing credential audiences. Pi's current
 `openai` login is checked first, but OpenAI exposes no supported quota endpoint
 for that API-scoped token. A legacy Codex login is therefore required for the
 separate ChatGPT usage endpoint until OpenAI publishes a compatible API.
 */
async function fetchOpenAiUsage(ctx: ExtensionCommandContext): Promise<string[]> {
  try {
    const hasCurrentLogin = readStoredCredential('openai')?.type === 'oauth';
    const resolved = await resolveOpenAiUsageAuth(ctx);
    if (resolved === undefined) {
      return hasCurrentLogin
        ? ['OPENAI', '  Unavailable: The new OpenAI login does not expose detailed quota usage.', '  Sign in with /login openai-codex to enable the secure compatibility path.']
        : ['OPENAI', '  Unavailable: Sign in with /login openai-codex.'];
    }

    const response = await requestOpenAiUsage(resolved);
    return response.ok ? formatOpenAiUsage(await response.json()) : ['OPENAI', `  Unavailable: Usage request failed (HTTP ${response.status}).`];
  } catch {
    return ['OPENAI', '  Unavailable: The usage request failed before a response was received.'];
  }
}

/**
 Fetches GitHub Copilot quota usage with the underlying GitHub OAuth token.
 Only the stable GitHub token from Pi's OAuth flow is accepted; inference and
 arbitrary API-key credentials are never forwarded to `api.github.com`.
 */
async function fetchCopilotUsage(_ctx: ExtensionCommandContext): Promise<string[]> {
  try {
    const credential = readStoredCredential('github-copilot');
    const token = credential?.type === 'oauth' ? credential.refresh : undefined;
    if (token === undefined || token.length === 0) {
      return ['GITHUB COPILOT', '  Unavailable: Sign in with /login github-copilot.'];
    }

    const response = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${token}`,
        'Editor-Version': 'vscode/1.107.0',
        'Editor-Plugin-Version': 'copilot-chat/0.35.0',
        'User-Agent': 'GitHubCopilotChat/0.35.0',
        'X-GitHub-Api-Version': '2025-04-01',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? formatCopilotUsage(await response.json()) : ['GITHUB COPILOT', `  Unavailable: Usage request failed (HTTP ${response.status}).`];
  } catch {
    return ['GITHUB COPILOT', '  Unavailable: The usage request failed before a response was received.'];
  }
}

/**
 Fetches both providers concurrently and displays one organized, read-only
 text block. Each provider reports errors independently so one unavailable
 account never hides valid usage from the other.
 */
async function showUsage(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify('Fetching OpenAI and GitHub Copilot usage…', 'info');
  const [openAi, copilot] = await Promise.all([fetchOpenAiUsage(ctx), fetchCopilotUsage(ctx)]);
  ctx.ui.notify(['USAGE', '─────', ...openAi, '', ...copilot].join('\n'), 'info');
}

/**
 Registers the `/usage` command. Fetching remains command-scoped so loading
 the extension never starts background work or sends credentials over the
 network.
 */
export default function usageExtension(pi: ExtensionAPI): void {
  pi.registerCommand('usage', {
    description: 'Show OpenAI and GitHub Copilot subscription usage',
    handler: showUsage,
  });
}
