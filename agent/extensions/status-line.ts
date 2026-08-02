import process from 'node:process';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';

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
  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    let gitStatus: GitStatus | undefined;

    try {
      const result = await pi.exec('git', ['status', '--porcelain=v1'], {
        cwd: ctx.cwd,
        timeout: 2000,
      });

      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
    } catch {
      gitStatus = undefined;
    }

    const {theme} = ctx.ui;
    const gitState = formatGitStatus(gitStatus);
    const git = gitStatus === undefined
      ? ''
      : `  ${theme.fg('accent', '')} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`;
    ctx.ui.setStatus('0:0-status-line', `${theme.fg('accent', getOsLabel())}${git} ${theme.fg('dim', '|')}`);
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshStatus(ctx);
    }
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (ctx.mode === 'tui') {
      await refreshStatus(ctx);
    }
  });
}
