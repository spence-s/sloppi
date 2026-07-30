import process from 'node:process';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';

type GitStatus = {
  staged: number;
  modified: number;
  untracked: number;
};

export function getOsLabel(platform = process.platform): string {
  if (platform === 'darwin') {
    return ' macOS';
  }

  if (platform === 'linux') {
    return ' Ubuntu';
  }

  return platform;
}

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

function formatGitStatus(status: GitStatus | undefined): string {
  if (status === undefined) {
    return '';
  }

  const parts = [
    status.staged > 0 ? `+${status.staged}` : '',
    status.modified > 0 ? `~${status.modified}` : '',
    status.untracked > 0 ? `?${status.untracked}` : '',
  ].filter(Boolean);

  return parts.length === 0 ? '✓' : parts.join(' ');
}

export default function statusLine(pi: ExtensionAPI): void {
  let gitStatus: GitStatus | undefined;
  let requestRender: (() => void) | undefined;

  const refreshGitStatus = async (cwd: string): Promise<void> => {
    try {
      const result = await pi.exec('git', ['status', '--porcelain=v1'], {
        cwd,
        timeout: 2000,
      });

      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
    } catch {
      gitStatus = undefined;
    }

    requestRender?.();
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    await refreshGitStatus(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => {
        tui.requestRender();
      };

      const unsubscribe = footerData.onBranchChange(requestRender);

      return {
        dispose: unsubscribe,
        invalidate(): void {
          return undefined;
        },
        render(width: number): string[] {
          const os = theme.fg('accent', getOsLabel());
          const branch = footerData.getGitBranch();
          const gitState = formatGitStatus(gitStatus);
          const git = branch === null
            ? ''
            : `  ${theme.fg('accent', '')} ${theme.fg('muted', branch)} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`;
          const statuses: string[] = [];
          for (const [, status] of footerData.getExtensionStatuses()) {
            statuses.push(status);
          }

          const extensions = statuses.length > 0
            ? `${theme.fg('dim', ' │ ')}${statuses.join(' ')}`
            : '';
          const left = `${os}${git}${extensions}`;
          const model = ctx.model === undefined
            ? 'no model'
            : `${ctx.model.id} • ${ctx.thinkingLevel}`;
          const padding = ' '.repeat(Math.max(1, width - visibleWidth(left) - model.length));

          return [truncateToWidth(`${left}${padding}${theme.fg('dim', model)}`, width)];
        },
      };
    });
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshGitStatus(ctx.cwd);
    }
  });
}
