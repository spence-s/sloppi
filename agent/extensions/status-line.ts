import process from 'node:process';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';

type GitStatus = {
  staged: number;
  modified: number;
  untracked: number;
};

const gateStatusIds = ['0:sudo-gate'];

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
  let requestRender = (): void => undefined;

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
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
          const branch = footerData.getGitBranch();
          const sessionName = ctx.sessionManager.getSessionName();
          const location = `${ctx.cwd}${branch === null ? '' : ` (${branch})`}${sessionName === undefined ? '' : ` • ${sessionName}`}`;
          const usage = ctx.getContextUsage();
          const model = ctx.model?.id ?? 'no-model';
          const modelStatus = usage === undefined
            ? model
            : `${usage.percent === null ? '?' : usage.percent.toFixed(1)}%/${String(usage.contextWindow)}  ${model}`;
          const thirdPartyStatuses = [...footerData.getExtensionStatuses()]
            .filter(([id]) => !gateStatusIds.includes(id))
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([, status]) => status)
            .join(' ');
          const gitParts = gitStatus === undefined
            ? []
            : [
              gitStatus.staged > 0 ? `+${gitStatus.staged}` : '',
              gitStatus.modified > 0 ? `~${gitStatus.modified}` : '',
              gitStatus.untracked > 0 ? `?${gitStatus.untracked}` : '',
            ].filter(Boolean);
          const gitState = gitParts.length === 0 ? '✓' : gitParts.join(' ');
          const git = gitStatus === undefined
            ? []
            : [`${theme.fg('accent', '')} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`];
          const gateStatuses = gateStatusIds
            .map(id => footerData.getExtensionStatuses().get(id))
            .filter(status => status !== undefined);
          let osLabel: string = process.platform;
          if (process.platform === 'darwin') {
            osLabel = ' macOS';
          } else if (process.platform === 'linux') {
            osLabel = ' Linux';
          }

          const ownStatus = [
            theme.fg('accent', osLabel),
            ...git,
            ...gateStatuses,
          ].join(theme.fg('dim', ' | '));
          return [
            theme.fg('dim', truncateToWidth(location, width)),
            theme.fg('dim', truncateToWidth(modelStatus, width)),
            ...(thirdPartyStatuses === '' ? [] : [truncateToWidth(thirdPartyStatuses, width)]),
            truncateToWidth(ownStatus, width),
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
}
