import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';

type GitStatus = {
  ahead: number;
  behind: number;
  branch: string;
  commit: string;
  conflicted: number;
  action: string;
  pushAhead: number;
  pushBehind: number;
  remoteBranch: string;
  staged: number;
  stashes: number;
  summary: string;
  tag: string;
  unstaged: number;
  untracked: number;
  upstream: string;
};

const compactNumber = new Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
  notation: 'compact',
});

export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = {
    ahead: 0,
    behind: 0,
    branch: '',
    commit: '',
    conflicted: 0,
    action: '',
    pushAhead: 0,
    pushBehind: 0,
    remoteBranch: '',
    staged: 0,
    stashes: 0,
    summary: '',
    tag: '',
    unstaged: 0,
    untracked: 0,
    upstream: '',
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      status.commit = line.slice(13);
    } else if (line.startsWith('# branch.head ')) {
      status.branch = line.slice(14) === '(detached)' ? '' : line.slice(14);
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice(18);
      status.remoteBranch = status.upstream.slice(status.upstream.indexOf('/') + 1);
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/v.exec(line);
      status.ahead = Number(match?.groups?.ahead ?? 0);
      status.behind = Number(match?.groups?.behind ?? 0);
    } else if (line.startsWith('# stash ')) {
      status.stashes = Number(line.slice(8));
    } else if (line.startsWith('? ')) {
      status.untracked += 1;
    } else if (line.startsWith('u ')) {
      status.conflicted += 1;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      status.staged += line[2] === '.' ? 0 : 1;
      status.unstaged += line[3] === '.' ? 0 : 1;
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
      const result = await pi.exec('git', ['status', '--porcelain=v2', '--branch', '--show-stash'], {
        cwd: ctx.cwd,
        timeout: 2000,
      });

      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
      if (gitStatus !== undefined) {
        const [summary, tag, gitDirectory, pushBranch] = await Promise.all([
          pi.exec('git', ['log', '-1', '--format=%s'], {cwd: ctx.cwd, timeout: 2000}),
          pi.exec('git', ['describe', '--tags', '--exact-match'], {cwd: ctx.cwd, timeout: 2000}),
          pi.exec('git', ['rev-parse', '--absolute-git-dir'], {cwd: ctx.cwd, timeout: 2000}),
          pi.exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], {cwd: ctx.cwd, timeout: 2000}),
        ]);
        gitStatus.summary = summary.code === 0 ? summary.stdout.trim() : '';
        gitStatus.tag = tag.code === 0 ? tag.stdout.trim() : '';

        if (gitDirectory.code === 0) {
          const directory = gitDirectory.stdout.trim();
          const actions = [
            ['rebase', ['rebase-merge', 'rebase-apply']],
            ['merge', ['MERGE_HEAD']],
            ['cherry-pick', ['CHERRY_PICK_HEAD']],
            ['revert', ['REVERT_HEAD']],
            ['bisect', ['BISECT_LOG']],
          ] as const;
          gitStatus.action = actions.find(([, paths]) => paths.some(path => existsSync(join(directory, path))))?.[0] ?? '';
        }

        const push = pushBranch.stdout.trim();
        if (pushBranch.code === 0 && push !== gitStatus.upstream) {
          const divergence = await pi.exec('git', ['rev-list', '--left-right', '--count', `HEAD...${push}`], {
            cwd: ctx.cwd,
            timeout: 2000,
          });
          const [ahead = 0, behind = 0] = divergence.stdout.trim().split(/\s+/v).map(Number);
          gitStatus.pushAhead = divergence.code === 0 ? ahead : 0;
          gitStatus.pushBehind = divergence.code === 0 ? behind : 0;
        }
      }
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
        dispose: footerData.onBranchChange(() => {
          void refreshStatus(ctx);
        }),
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

          let git = '';
          if (gitStatus !== undefined) {
            let reference = gitStatus.branch;
            if (reference.length > 32) {
              reference = `${reference.slice(0, 12)}…${reference.slice(-12)}`;
            }

            if (reference.length === 0) {
              reference = gitStatus.tag.length > 0 ? `#${gitStatus.tag}` : `@${gitStatus.commit.slice(0, 8)}`;
            }

            const remote = gitStatus.remoteBranch.length > 0 && gitStatus.remoteBranch !== gitStatus.branch
              ? `${theme.fg('muted', ':')}${theme.fg('success', gitStatus.remoteBranch)}`
              : '';
            const divergence = `${gitStatus.behind > 0 ? `⇣${gitStatus.behind}` : ''}${gitStatus.ahead > 0 ? `⇡${gitStatus.ahead}` : ''}`;
            const pushDivergence = `${gitStatus.pushBehind > 0 ? `⇠${gitStatus.pushBehind}` : ''}${gitStatus.pushAhead > 0 ? `⇢${gitStatus.pushAhead}` : ''}`;
            const parts = [
              `${theme.fg('success', `   ${reference}`)}${remote}`,
              /(?:^|[^\da-z])wip(?:[^\da-z]|$)/iv.test(gitStatus.summary) ? theme.fg('warning', 'wip') : '',
              divergence.length > 0 ? theme.fg('success', divergence) : '',
              pushDivergence.length > 0 ? theme.fg('success', pushDivergence) : '',
              gitStatus.stashes > 0 ? theme.fg('success', `*${gitStatus.stashes}`) : '',
              gitStatus.action.length > 0 ? theme.fg('error', gitStatus.action) : '',
              gitStatus.conflicted > 0 ? theme.fg('error', `~${gitStatus.conflicted}`) : '',
              gitStatus.staged > 0 ? theme.fg('warning', `+${gitStatus.staged}`) : '',
              gitStatus.unstaged > 0 ? theme.fg('warning', `!${gitStatus.unstaged}`) : '',
              gitStatus.untracked > 0 ? theme.fg('syntaxFunction', `?${gitStatus.untracked}`) : '',
            ].filter(Boolean);
            git = parts.join(' ');
          }

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
