import type {ExtensionAPI, Theme} from '@earendil-works/pi-coding-agent';

type BannerTheme = Pick<Theme, 'fg'>;

const wideLogo = [
  '  ███████╗██╗      ██████╗ ██████╗ ██████╗ ██╗',
  '  ██╔════╝██║     ██╔═══██╗██╔══██╗██╔══██╗██║',
  '  ███████╗██║     ██║   ██║██████╔╝██████╔╝██║',
  '  ╚════██║██║     ██║   ██║██╔═══╝ ██╔═══╝ ██║',
  '  ███████║███████╗╚██████╔╝██║     ██║     ██║',
  '  ╚══════╝╚══════╝ ╚═════╝ ╚═╝     ╚═╝     ╚═╝',
];

export function getBannerLines(width: number, theme: BannerTheme): string[] {
  const accent = (text: string): string => theme.fg('accent', text);
  const muted = (text: string): string => theme.fg('muted', text);
  const dim = (text: string): string => theme.fg('dim', text);

  if (width >= 72) {
    return [
      ...wideLogo.map((line) => accent(line)),
      muted('  personal coding command center'),
      dim('  /pipeline <goal>  ·  /ask [on|off]  ·  /hotkeys'),
      '',
    ];
  }

  const fit = (text: string): string => text.slice(0, Math.max(0, width));

  if (width >= 48) {
    return [
      accent(fit('✦ SLOPPI  ')) + muted(fit('personal coding command center')),
      dim(fit('/pipeline <goal>  ·  /ask [on|off]  ·  /hotkeys')),
      '',
    ];
  }

  return [accent(fit('✦ SLOPPI')), dim(fit('/hotkeys for commands')), ''];
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
