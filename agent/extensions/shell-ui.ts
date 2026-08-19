import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import process from 'node:process';
import {stripVTControlCharacters} from 'node:util';
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  type EditorTheme,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from '@earendil-works/pi-tui';

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

export default function shellUi(pi: ExtensionAPI): void {
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

      const statusRows = {
        invalidate: () => undefined,
        render(width: number): string[] {
          const renderRow = (left: string, right: string, hasFill = false): string => {
            const fittedRight = truncateToWidth(right, Math.max(0, width - 1), '');
            const rightWidth = visibleWidth(fittedRight);
            const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - (rightWidth > 0 ? 1 : 0)), '');
            const gap = Math.max(0, width - visibleWidth(fittedLeft) - rightWidth);
            const middle = hasFill && gap > 2
              ? ` ${theme.fg('borderMuted', '─'.repeat(gap - 2))} `
              : ' '.repeat(gap);
            return `${fittedLeft}${middle}${fittedRight}`;
          };

          const extensionStatuses = footerData.getExtensionStatuses();
          const sandboxStatus = extensionStatuses.get('sandbox') ?? theme.fg('warning', 'sandbox ?');
          const modeStatus = extensionStatuses.get('ask-mode') ?? theme.fg('dim', 'agent');
          const additionalStatuses = [...extensionStatuses]
            .filter(([id]) => id !== 'sandbox' && id !== 'ask-mode')
            .map(([, status]) => status);

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
              `${theme.fg('syntaxKeyword', '')}  ${theme.fg('success', ` ${reference}`)}${remote}`,
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
          const osIcon = theme.fg('text', osIcons[process.platform] ?? process.platform);
          const homeDirectory = homedir();
          const cwd = ctx.cwd === homeDirectory || ctx.cwd.startsWith(`${homeDirectory}/`)
            ? `~${ctx.cwd.slice(homeDirectory.length)}`
            : ctx.cwd;

          const usage = ctx.getContextUsage();
          const contextPercent = usage?.percent;
          let contextColor: 'accent' | 'error' | 'warning' | 'syntaxNumber' = 'accent';

          if (typeof contextPercent === 'number' && contextPercent >= 60) {
            contextColor = 'error';
          } else if (typeof contextPercent === 'number' && contextPercent >= 40) {
            contextColor = 'syntaxNumber';
          } else if (typeof contextPercent === 'number' && contextPercent >= 15) {
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
          const pending = ctx.hasPendingMessages() ? theme.fg('warning', '󰅖 queued') : '';
          const workspacePath = `${osIcon} ${theme.fg('mdHeading', `  ${cwd}`)}`;
          const workspace = `${workspacePath} on ${git}`;
          const essentialStatus = [sandboxStatus, modeStatus, pending].filter(Boolean).join('  ');
          const status = [sandboxStatus, modeStatus, ...additionalStatuses, pending].filter(Boolean).join('  ');
          const compaction = theme.fg('muted', `󰆏 ${compactions}`);
          const compactContext = usage === undefined
            ? `${theme.fg('toolTitle', '󰍛')} ${theme.bold(theme.fg('warning', '?'))}`
            : `${theme.fg('toolTitle', '󰍛')} ${theme.bold(theme.fg(contextColor, usage.percent === null ? '?' : `${usage.percent.toFixed(0)}%`))}`;

          if (width < 60) {
            const directoryName = basename(ctx.cwd);
            const directory = ctx.cwd === homeDirectory
              ? '~'
              : (directoryName.length > 0 ? directoryName : ctx.cwd);
            const compactWorkspace = `${osIcon} ${theme.fg('mdHeading', ` ${directory}`)}`;
            return [
              renderRow([compactWorkspace, git].filter(Boolean).join('  '), ''),
              renderRow([essentialStatus, compactContext].filter(Boolean).join('  '), ''),
            ];
          }

          if (width < 80) {
            return [
              renderRow(workspacePath, git),
              renderRow(essentialStatus, `${compactContext}  ${cost}`),
            ];
          }

          return [
            renderRow(workspace, `${model}  ${thinking}`, true),
            renderRow(status, `${context}  ${cost}  ${compaction}`),
          ];
        },
      };
      const topStatus = {
        invalidate() {
          statusRows.invalidate();
        },
        render(width: number): string[] {
          const plainPrefix = truncateToWidth('├─ ', Math.max(0, width - 1), '');
          const line = statusRows.render(Math.max(1, width - visibleWidth(plainPrefix)))[0] ?? '';
          return [`${theme.fg('dim', plainPrefix)}${line}`];
        },
      };
      const bottomStatus = {
        invalidate() {
          statusRows.invalidate();
        },
        render(width: number): string[] {
          const plainPrefix = truncateToWidth('╰─ ', Math.max(0, width - 1), '');
          const line = statusRows.render(Math.max(1, width - visibleWidth(plainPrefix)))[1] ?? '';
          return [`${theme.fg('dim', plainPrefix)}${line}`];
        },
      };
      const unsubscribe = footerData.onBranchChange(() => {
        void refreshStatus(ctx);
      });
      const unsubscribeUserBash = pi.events.on('sloppi:user-bash-end', () => {
        void refreshStatus(ctx);
      });
      ctx.ui.setWidget('shell-ui-top', () => topStatus, {placement: 'belowEditor'});
      ctx.ui.setWidget('shell-ui-bottom', () => bottomStatus, {placement: 'belowEditor'});

      return {
        dispose() {
          unsubscribe();
          unsubscribeUserBash();
          ctx.ui.setWidget('shell-ui-top', undefined);
          ctx.ui.setWidget('shell-ui-bottom', undefined);
        },
        invalidate() {
          topStatus.invalidate();
          bottomStatus.invalidate();
        },
        render: () => [],
      };
    });

    class PromptEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, {paddingX: 0});
      }

      render(width: number): string[] {
        const plainPrefix = truncateToWidth('╭─❯ ', Math.max(0, width - 1), '');
        const prefixWidth = visibleWidth(plainPrefix);
        const indent = ' '.repeat(prefixWidth);
        const continuationPrefix = prefixWidth === 0 ? '' : `│${' '.repeat(prefixWidth - 1)}`;
        const lines = super.render(Math.max(1, width - prefixWidth));
        const isBorder = (line: string): boolean => /^(?:─+|─── [↑↓] \d+ more ─*)$/v.test(stripVTControlCharacters(line));
        const bottomBorderIndex = lines.findIndex((line, index) => index > 0 && isBorder(line));
        if (bottomBorderIndex === -1) {
          return lines;
        }

        const topBorder = lines[0] ?? '';
        const bottomBorder = lines[bottomBorderIndex] ?? '';
        const prefixCharacters = [...plainPrefix];
        const corner = prefixCharacters.slice(0, 2).join('');
        const arrow = prefixCharacters.slice(2).join('');
        const input = lines.slice(1, bottomBorderIndex).map((line, index) => index === 0
          ? `${ctx.ui.theme.fg('dim', corner)}${this.borderColor(arrow)}${line}`
          : `${ctx.ui.theme.fg('dim', continuationPrefix)}${line}`);
        const autocomplete = lines.slice(bottomBorderIndex + 1).map(line => `${ctx.ui.theme.fg('dim', continuationPrefix)}${line}`);

        return [
          `${this.borderColor('─'.repeat(prefixWidth))}${topBorder}`,
          ...input,
          ...stripVTControlCharacters(bottomBorder).includes('↓') ? [`${indent}${bottomBorder}`] : [],
          ...autocomplete,
        ];
      }
    }

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings));
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
