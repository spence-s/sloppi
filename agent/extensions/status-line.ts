import {basename} from 'node:path';
import process from 'node:process';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';

type GitStatus = {
  staged: number;
  modified: number;
  untracked: number;
};

type SessionStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  compactions: number;
};

const compactNumber = new Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
  notation: 'compact',
});

export function parseGitStatus(output: string): GitStatus {
  const status = {staged: 0, modified: 0, untracked: 0};

  for (const line of output.split('\n')) {
    if (line.startsWith('??')) {
      status.untracked += 1;
      continue;
    }

    const [indexStatus = ' ', worktreeStatus = ' '] = line;
    if (indexStatus !== ' ') {
      status.staged += 1;
    }

    if (worktreeStatus !== ' ') {
      status.modified += 1;
    }
  }

  return status;
}

export default function statusLine(pi: ExtensionAPI): void {
  let gitStatus: GitStatus | undefined;
  let sessionStats: SessionStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    compactions: 0,
  };
  let requestRender = (): void => undefined;

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    const stats: SessionStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      compactions: 0,
    };
    const addUsage = (usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: {total: number};
    } | undefined): void => {
      if (usage === undefined) {
        return;
      }

      stats.input += usage.input;
      stats.output += usage.output;
      stats.cacheRead += usage.cacheRead;
      stats.cacheWrite += usage.cacheWrite;
      stats.cost += usage.cost.total;
    };

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'message' && entry.message.role === 'assistant') {
        stats.turns += 1;
        addUsage(entry.message.usage);
      } else if (entry.type === 'message' && entry.message.role === 'toolResult') {
        addUsage(entry.message.usage);
      } else if (entry.type === 'compaction') {
        stats.compactions += 1;
        addUsage(entry.usage);
      } else if (entry.type === 'branch_summary') {
        addUsage(entry.usage);
      }
    }

    sessionStats = stats;

    try {
      const result = await pi.exec('git', ['status', '--porcelain=v1'], {
        cwd: ctx.cwd,
        timeout: 2000,
      });

      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
    } catch {
      gitStatus = undefined;
    }

    requestRender();
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    await refreshStatus(ctx);
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = (): void => {
        tui.requestRender();
      };

      return {
        dispose: footerData.onBranchChange(requestRender),
        invalidate: () => undefined,
        render(width: number): string[] {
          const renderRow = (segments: string[]): string => {
            const start = '';
            const separator = theme.bg('toolPendingBg', theme.fg('borderMuted', ''));
            const end = theme.fg('borderMuted', '▏');
            let row = start;
            let count = 0;

            for (const segment of segments) {
              if (segment.length === 0) {
                continue;
              }

              const next = `${row}${count === 0 ? '' : separator}${theme.bg('toolPendingBg', ` ${segment}`)}`;
              if (visibleWidth(`${next}${end}`) > width) {
                break;
              }

              row = next;
              count += 1;
            }

            return count === 0 ? '' : `${row}${end}`;
          };

          const extensionStatuses = footerData.getExtensionStatuses();
          const sandboxStatus = extensionStatuses.get('0:sandbox') ?? theme.fg('warning', 'sandbox ?');
          const modeStatus = extensionStatuses.get('0:ask-mode') ?? theme.fg('dim', 'default');
          const extraStatuses = [...extensionStatuses]
            .filter(([key]) => !['0:sandbox', '0:ask-mode', 'ponytail'].includes(key))
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([, status]) => status);

          const branch = footerData.getGitBranch();
          const gitParts = gitStatus === undefined
            ? []
            : [
              gitStatus.staged > 0 ? `+${gitStatus.staged}` : '',
              gitStatus.modified > 0 ? `~${gitStatus.modified}` : '',
              gitStatus.untracked > 0 ? `?${gitStatus.untracked}` : '',
            ].filter(Boolean);
          const gitState = gitParts.length === 0 ? '✓' : gitParts.join(' ');
          const git = branch === null
            ? ''
            : `${theme.fg('success', '')} ${theme.fg('syntaxFunction', branch)} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`;

          const osLabels: Partial<Record<NodeJS.Platform, string>> = {
            darwin: ' macOS',
            linux: ' Linux',
            win32: ' Windows',
          };
          const osLabel = theme.fg('toolTitle', osLabels[process.platform] ?? process.platform);

          const usage = ctx.getContextUsage();
          const context = theme.fg('syntaxNumber', usage === undefined
            ? '󰍛 ctx ?'
            : `󰍛 ${usage.percent === null ? '?' : `${usage.percent.toFixed(1)}%`} ${usage.tokens === null ? '?' : compactNumber.format(usage.tokens)}/${compactNumber.format(usage.contextWindow)}`);
          const model = theme.fg('syntaxType', ctx.model === undefined
            ? '󰧑 no model'
            : `󰧑 ${ctx.model.provider}/${ctx.model.id}`);
          const thinking = theme.fg('syntaxKeyword', `󰔏 ${ctx.thinkingLevel ?? 'off'}`);
          const runtime = ctx.isIdle()
            ? theme.fg('success', '󰒲 idle')
            : theme.fg('warning', '󰚩 busy');
          const pending = ctx.hasPendingMessages() ? theme.fg('warning', '󰅖 queued') : '';
          const trust = ctx.isProjectTrusted()
            ? theme.fg('success', '󰌾 trusted')
            : theme.fg('warning', '󰿆 untrusted');

          const sessionName = ctx.sessionManager.getSessionName();
          const sessionId = ctx.sessionManager.getSessionId().slice(0, 8);
          const session = `${theme.fg('toolTitle', '󰭻')} ${sessionName ?? sessionId}${ctx.sessionManager.getSessionFile() === undefined ? ' ephemeral' : ''}`;
          const tools = `${theme.fg('toolTitle', '󰡱')} ${theme.fg('syntaxNumber', `${pi.getActiveTools().length}/${pi.getAllTools().length}`)} tools`;
          const commands = pi.getCommands();
          const skills = commands.filter(command => command.source === 'skill').length;
          const templates = commands.filter(command => command.source === 'prompt').length;
          const providers = footerData.getAvailableProviderCount();
          const scopedModels = ctx.scopedModels.length;
          const cost = `$${sessionStats.cost < 1 ? sessionStats.cost.toFixed(3) : sessionStats.cost.toFixed(2)}`;

          const workspaceRow = renderRow([
            osLabel,
            `${theme.fg('toolTitle', '')} ${basename(ctx.cwd)}`,
            git,
            sandboxStatus,
            modeStatus,
            session,
          ]);
          const runtimeRow = renderRow([
            model,
            thinking,
            context,
            runtime,
            pending,
            trust,
          ]);
          const telemetryRow = renderRow([
            `${theme.fg('toolTitle', '󰘚')} ${theme.fg('syntaxNumber', `↑${compactNumber.format(sessionStats.input)} ↓${compactNumber.format(sessionStats.output)}`)}`,
            `${theme.fg('toolTitle', '󰓅')} ${theme.fg('syntaxNumber', `${compactNumber.format(sessionStats.cacheRead)}/${compactNumber.format(sessionStats.cacheWrite)}`)} cache`,
            theme.fg('syntaxNumber', cost),
            `${theme.fg('syntaxNumber', String(sessionStats.turns))} turns`,
            tools,
            `${theme.fg('syntaxKeyword', '󰘳')} ${theme.fg('syntaxNumber', String(skills))} skills/${theme.fg('syntaxNumber', String(templates))} prompts`,
            `${theme.fg('toolTitle', '󰒋')} ${theme.fg('syntaxNumber', String(providers))} providers`,
            ...(scopedModels === 0 ? [] : [`󰊴 ${scopedModels} scoped`]),
            ...(sessionStats.compactions === 0 ? [] : [`󰆏 ${sessionStats.compactions} compact`]),
            ...extraStatuses,
          ]);

          if (width >= 120) {
            return [workspaceRow, runtimeRow, telemetryRow].filter(Boolean);
          }

          if (width >= 80) {
            return [
              renderRow([`${theme.fg('toolTitle', '')} ${basename(ctx.cwd)}`, git, sandboxStatus, modeStatus]),
              renderRow([model, thinking, context, runtime, cost, tools]),
            ].filter(Boolean);
          }

          return [truncateToWidth(renderRow([git, sandboxStatus, modeStatus, context]), width)].filter(Boolean);
        },
      };
    });
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshStatus(ctx);
    }
  });

  pi.on('session_tree', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshStatus(ctx);
    }
  });

  pi.on('session_compact', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshStatus(ctx);
    }
  });
}
