import process from 'node:process';
import {
  FooterComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';

type GitStatus = {
  staged: number;
  modified: number;
  untracked: number;
};

const gateStatusIds = ['0:sudo-gate', '1:delete-gate'];

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

      const thirdPartyFooterData = {
        getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
        getExtensionStatuses() {
          return new Map([...footerData.getExtensionStatuses()].filter(([id]) => !gateStatusIds.includes(id)));
        },
        getGitBranch: () => footerData.getGitBranch(),
        onBranchChange: (callback: () => void) => footerData.onBranchChange(callback),
      };
      const footer = new FooterComponent({
        get state() {
          return {model: ctx.model, thinkingLevel: ctx.thinkingLevel};
        },
        sessionManager: ctx.sessionManager,
        getContextUsage: () => ctx.getContextUsage(),
        modelRuntime: {isUsingOAuth: () => false},
      } as unknown as ConstructorParameters<typeof FooterComponent>[0], thirdPartyFooterData);
      const unsubscribe = footerData.onBranchChange(requestRender);

      return {
        dispose() {
          unsubscribe();
          footer.dispose();
        },
        invalidate() {
          footer.invalidate();
        },
        render(width: number): string[] {
          const gitState = formatGitStatus(gitStatus);
          const git = gitStatus === undefined
            ? []
            : [`${theme.fg('accent', '')} ${theme.fg(gitState === '✓' ? 'success' : 'warning', gitState)}`];
          const gateStatuses = gateStatusIds
            .map(id => footerData.getExtensionStatuses().get(id))
            .filter(status => status !== undefined);
          const ownStatus = [
            theme.fg('accent', getOsLabel()),
            ...git,
            ...gateStatuses,
          ].join(theme.fg('dim', ' | '));
          return [...footer.render(width), truncateToWidth(ownStatus, width)];
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
