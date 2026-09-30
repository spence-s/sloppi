import {describe, test, type TestContext} from 'node:test';
import type {ThemeStyle} from '@earendil-works/pi-coding-agent';
import {colorToHex, visibleWidth} from '@earendil-works/pi-tui';
import {getBannerLines} from '../agent/extensions/startup-banner.ts';

const theme = {
  fg: (_token: string, text: string) => text,
  style: (text: string, _options: ThemeStyle) => text,
};

void describe('startup-banner', () => {
  void test('uses the SLOPPI logo in the wide banner', (t: TestContext) => {
    const banner = getBannerLines(79, theme).join('\n');

    t.assert.ok(banner.includes('███████╗██╗      ██████╗'));
    t.assert.ok(banner.includes('╭╮  )(  ╭╮   )'));
    t.assert.ok(banner.includes('╲╲'));
    t.assert.ok(banner.includes('╔════════════════╗'));
    t.assert.ok(!banner.toLowerCase().includes('spencer'));
  });

  void test('uses the official Pi colors for the final PI mark', (t: TestContext) => {
    const brandedTheme = {
      fg: (_token: string, text: string) => text,
      /**
       Exposes concrete colors in the rendered text so this test can verify
       brand assignments without depending on terminal ANSI capabilities.
       */
      style(text: string, options: ThemeStyle) {
        const color = typeof options.fg === 'string' || options.fg === undefined
          ? options.fg
          : colorToHex(options.fg);
        return `[${color}]${text}[/]`;
      },
    };
    const wideBanner = getBannerLines(79, brandedTheme);

    t.assert.ok(wideBanner.slice(0, 3).every(line => line.includes('[#f09082]')));
    t.assert.ok(wideBanner.slice(3, 6).every(line => line.includes('[#4d9abf]')));
    t.assert.ok(wideBanner.slice(0, 3).every(line => !line.includes('[#f1be58]')));
    t.assert.ok(wideBanner.slice(3, 6).every(line => line.includes('[#f1be58]')));
    t.assert.ok(getBannerLines(48, brandedTheme)[0]?.includes('[#4d9abf]P[/][#f1be58]I[/]'));
  });

  void test('uses the SLOPPI name in compact banners', (t: TestContext) => {
    t.assert.deepStrictEqual(getBannerLines(48, theme), [
      '✦ SLOPPI  🍜 personal coding command center',
      '/ask [on|off]  ·  /sandbox  ·  /hotkeys',
      '',
    ]);
    t.assert.deepStrictEqual(getBannerLines(47, theme), [
      '✦ SLOPPI 🍜',
      '/hotkeys for commands',
      '',
    ]);
  });

  void test('fits narrow and breakpoint banners within the terminal', (t: TestContext) => {
    const widths = [10, 20, 32, 40, 48, 60, 78, 79, 100];
    t.assert.ok(widths.every(width =>
      getBannerLines(width, theme).every(line => visibleWidth(line) <= width)));
  });
});
