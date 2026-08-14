import {homedir} from 'node:os';
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
  let sessionCost = 0;
  let compactions = 0;
  let requestRender = (): void => undefined;

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    sessionCost = 0;
    compactions = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'message' && entry.message.role === 'assistant') {
        sessionCost += entry.message.usage.cost.total;
      } else if (entry.type === 'message' && entry.message.role === 'toolResult') {
        sessionCost += entry.message.usage?.cost.total ?? 0;
      } else if (entry.type === 'compaction') {
        compactions += 1;
        sessionCost += entry.usage?.cost.total ?? 0;
      } else if (entry.type === 'branch_summary') {
        sessionCost += entry.usage?.cost.total ?? 0;
      }
    }

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
          const renderRow = (left: string, right: string, edge: string, hasFill = false): string => {
            const start = `${theme.bold(theme.fg('muted', edge))} `;
            const rightWidth = visibleWidth(right);
            const fittedLeft = truncateToWidth(`${start}${left}`, Math.max(0, width - rightWidth - 3));
            const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
            const middle = hasFill && gap > 2
              ? ` ${theme.fg('borderMuted', '─'.repeat(gap - 2))} `
              : ' '.repeat(gap);
            return `${fittedLeft}${middle}${right}`;
          };

          const extensionStatuses = footerData.getExtensionStatuses();
          const sandboxStatus = extensionStatuses.get('sandbox') ?? theme.fg('warning', 'sandbox ?');
          const modeStatus = extensionStatuses.get('chat-mode') ?? theme.fg('dim', 'agent');

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
            : `${theme.fg('muted', 'on')} ${theme.fg('success', '')} ${theme.fg('syntaxFunction', branch)} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`;

          const osIcons: Partial<Record<NodeJS.Platform, string>> = {
            darwin: '',
            linux: '',
            win32: '',
          };
          const osIcon = theme.fg('toolTitle', osIcons[process.platform] ?? process.platform);
          const homeDirectory = homedir();
          const cwd = ctx.cwd === homeDirectory || ctx.cwd.startsWith(`${homeDirectory}/`)
            ? `~${ctx.cwd.slice(homeDirectory.length)}`
            : ctx.cwd;

          const usage = ctx.getContextUsage();
          const contextPercent = usage?.percent;
          let contextColor: 'error' | 'warning' | 'syntaxNumber' = 'syntaxNumber';

          if (typeof contextPercent === 'number' && contextPercent >= 80) {
            contextColor = 'error';
          } else if (typeof contextPercent === 'number' && contextPercent >= 60) {
            contextColor = 'warning';
          }

          const context = usage === undefined
            ? `${theme.fg('toolTitle', '󰍛')} ${theme.bold(theme.fg('warning', 'ctx ?'))}`
            : `${theme.fg('toolTitle', '󰍛')} ${theme.bold(theme.fg(contextColor, usage.percent === null
              ? '?'
              : `${usage.percent.toFixed(1)}%`))} ${theme.fg('muted', `${usage.tokens === null ? '?' : compactNumber.format(usage.tokens)}/${compactNumber.format(usage.contextWindow)}`)}`;
          const model = theme.fg('syntaxType', ctx.model === undefined
            ? '󰧑 no model'
            : `󰧑 ${ctx.model.provider}/${ctx.model.id}`);
          const cost = theme.fg('muted', `$${sessionCost < 1 ? sessionCost.toFixed(3) : sessionCost.toFixed(2)}`);
          const thinking = theme.fg('syntaxKeyword', `󰔏 ${ctx.thinkingLevel ?? 'off'}`);
          const runtime = ctx.isIdle()
            ? theme.fg('success', '󰒲 idle')
            : theme.fg('warning', '󰚩 busy');
          const pending = ctx.hasPendingMessages() ? theme.fg('warning', '󰅖 queued') : '';
          const workspace = `${osIcon} ${theme.fg('mdHeading', '')}  ${cwd} ${git}`;
          const status = [runtime, thinking, sandboxStatus, modeStatus, pending].filter(Boolean).join('  ');
          const compaction = theme.fg('muted', `󰆏 ${compactions}`);

          return [
            renderRow(workspace, model, '╭─', true),
            renderRow(status, `${context}  ${cost}  ${compaction}`, '╰─'),
          ];
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
