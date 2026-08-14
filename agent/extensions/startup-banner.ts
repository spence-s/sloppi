import type {ExtensionAPI, Theme} from '@earendil-works/pi-coding-agent';

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
  if (width >= 72) {
    return [
      ...wideLogo.map(line => theme.fg('accent', line)),
      theme.fg('muted', '  personal coding command center'),
      theme.fg('dim', '  /chat [on|off]  ·  /sandbox  ·  /hotkeys'),
      '',
    ];
  }

  if (width >= 48) {
    return [
      theme.fg('accent', '✦ SLOPPI  🍜 '.slice(0, Math.max(0, width)))
      + theme.fg('muted', 'personal coding command center'.slice(0, Math.max(0, width))),
      theme.fg('dim', '/chat [on|off]  ·  /sandbox  ·  /hotkeys'.slice(0, Math.max(0, width))),
      '',
    ];
  }

  return [
    theme.fg('accent', '✦ SLOPPI 🍜'.slice(0, Math.max(0, width))),
    theme.fg('dim', '/hotkeys for commands'.slice(0, Math.max(0, width))),
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
