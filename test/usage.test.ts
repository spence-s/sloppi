import {describe, test, type TestContext} from 'node:test';
import {formatCopilotUsage, formatOpenAiUsage} from '../agent/extensions/usage.ts';

const now = Date.parse('2026-01-01T00:00:00Z');

void describe('usage', () => {
  void test('formats OpenAI five-hour and weekly limits by duration', (t: TestContext) => {
    const lines = formatOpenAiUsage({
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3660,
        },
        secondary_window: {
          used_percent: 60.5,
          limit_window_seconds: 604_800,
          reset_at: (now + 86_400_000) / 1000,
        },
      },
      credits: {has_credits: false, unlimited: false, balance: '0'},
    }, now).join('\n');

    t.assert.match(lines, /Plan: Plus/v);
    t.assert.match(lines, /5-hour window\n {4}Used: 25\.0% {2}• {2}Left: 75\.0%/v);
    t.assert.match(lines, /Weekly window\n {4}Used: 60\.5% {2}• {2}Left: 39\.5%/v);
    t.assert.match(lines, /2026-01-02T00:00:00Z \(in 1d\)/v);
    t.assert.match(lines, /Credits: None/v);
  });

  void test('formats Copilot counts, unlimited quotas, overages, and reset', (t: TestContext) => {
    const lines = formatCopilotUsage({
      copilot_plan: 'individual',
      quota_reset_date: '2026-02-01T00:00:00Z',
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          remaining: 123,
          percent_remaining: 41,
          unlimited: false,
          has_quota: true,
          overage_count: 2,
          overage_permitted: true,
        },
        chat: {
          entitlement: '-1',
          remaining: 0,
          percent_remaining: 100,
          unlimited: true,
        },
        completions: {
          entitlement: 0,
          remaining: 0,
          percent_remaining: 0,
          unlimited: false,
          has_quota: false,
        },
      },
    }, now).join('\n');

    t.assert.match(lines, /Plan: Individual/v);
    t.assert.match(lines, /Premium requests: 41\.0% \(123 \/ 300\) left/v);
    t.assert.match(lines, /Additional usage: Enabled {2}• {2}Used: 2/v);
    t.assert.match(lines, /Chat messages: Unlimited/v);
    t.assert.match(lines, /Code completions: Not included in this plan/v);
    t.assert.match(lines, /Monthly reset: 2026-02-01T00:00:00Z \(in 31d\)/v);
  });
});
