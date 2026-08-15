import type {ExtensionAPI, Theme} from '@earendil-works/pi-coding-agent';
import {truncateToWidth} from '@earendil-works/pi-tui';

type BannerTheme = Pick<Theme, 'fg'>;

const wideLogo = [
  '  ███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗       ╭╮  )(  ╭╮   )       ╲╲',
  '  ██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║       ╰╯ (  ) ╰╯  (         ╲╲',
  '  ███████╗██║     ██║   ██║██████╔╝██████╔╝██║     ╔════════════════╗       ╲╲',
  '  ╚════██║██║     ██║   ██║██╔═══╝ ██╔═══╝ ██║     ║ ██  ≋≋≋  ██  ≋≋ ║       ╲╲',
  '  ███████║███████╗╚██████╔╝██║     ██║     ██║      ╚██████████████╝',
  '  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝     ╚═╝        ████████████',
];

export function getBannerLines(width: number, theme: BannerTheme): string[] {
  if (width >= 79) {
    return [
      ...wideLogo.map(line => theme.fg('accent', line)),
      theme.fg('muted', '  personal coding command center'),
      theme.fg('dim', '  /chat [on|off]  ·  /sandbox  ·  /hotkeys'),
      '',
    ];
  }

  if (width >= 48) {
    return [
      theme.fg('accent', '✦ SLOPPI  🍜 ') + theme.fg('muted', 'personal coding command center'),
      theme.fg('dim', '/chat [on|off]  ·  /sandbox  ·  /hotkeys'),
      '',
    ];
  }

  return [
    theme.fg('accent', truncateToWidth('✦ SLOPPI 🍜', width, '')),
    theme.fg('dim', truncateToWidth('/hotkeys for commands', width, '')),
    '',
  ];
}

export default function startupBanner(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return;
    }

    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number): string[] => getBannerLines(width, theme),
      invalidate(): void {
        return undefined;
      },
    }));
  });
}
