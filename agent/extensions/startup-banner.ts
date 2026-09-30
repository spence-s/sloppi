import type {ExtensionAPI, Theme} from '@earendil-works/pi-coding-agent';
import {parseColor, truncateToWidth} from '@earendil-works/pi-tui';

type BannerTheme = Pick<Theme, 'fg' | 'style'>;

const piRed = parseColor('#F09082');
const piBlue = parseColor('#4D9ABF');
const piOrange = parseColor('#F1BE58');

const wideLogo = [
  ['  ███████╗██╗      ██████╗ ██████╗ ', '██████╗', ' ', undefined, '       ╭╮  )(  ╭╮   )       ╲╲'],
  ['  ██╔════╝██║     ██╔═══██╗██╔══██╗', '██╔══██╗', '', undefined, '       ╰╯ (  ) ╰╯  (         ╲╲'],
  ['  ███████╗██║     ██║   ██║██████╔╝', '██████╔╝', '', undefined, '     ╔════════════════╗       ╲╲'],
  ['  ╚════██║██║     ██║   ██║██╔═══╝ ', '██╔═══╝ ', '', '██╗', '     ║ ██  ≋≋≋  ██  ≋≋ ║       ╲╲'],
  ['  ███████║███████╗╚██████╔╝██║     ', '██║     ', '', '██║', '      ╚██████████████╝'],
  ['  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ', '╚═╝     ', '', '╚═╝', '        ████████████'],
] as const;

/**
 Builds the responsive startup banner while keeping the surrounding Sloppi
 artwork tied to the active theme. Only the final PI mark uses Pi's fixed
 brand colors, so changing themes still updates the rest of the header.
 */
export function getBannerLines(width: number, theme: BannerTheme): string[] {
  if (width >= 79) {
    return [
      ...wideLogo.map(([prefix, p, gap, i, suffix], index) =>
        theme.fg('accent', prefix)
        + theme.style(p, {fg: index < 3 ? piRed : piBlue})
        + gap
        + (i === undefined ? ' '.repeat(3) : theme.style(i, {fg: piOrange}))
        + theme.fg('accent', suffix)),
      theme.fg('muted', '  personal coding command center'),
      theme.fg('dim', '  /ask [on|off]  ·  /sandbox  ·  /hotkeys'),
      '',
    ];
  }

  const compactName = theme.fg('accent', '✦ SLOP')
    + theme.style('P', {fg: piBlue})
    + theme.style('I', {fg: piOrange});

  if (width >= 48) {
    return [
      compactName + theme.fg('accent', '  🍜 ') + theme.fg('muted', 'personal coding command center'),
      theme.fg('dim', '/ask [on|off]  ·  /sandbox  ·  /hotkeys'),
      '',
    ];
  }

  return [
    truncateToWidth(compactName + theme.fg('accent', ' 🍜'), width, ''),
    theme.fg('dim', truncateToWidth('/hotkeys for commands', width, '')),
    '',
  ];
}

/**
 Replaces Pi's default interactive header with the responsive Sloppi banner.
 Non-TUI modes are deliberately untouched because they cannot render it.
 */
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
