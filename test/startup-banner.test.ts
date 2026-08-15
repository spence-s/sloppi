import {describe, test, type TestContext} from 'node:test';
import {visibleWidth} from '@earendil-works/pi-tui';
import {getBannerLines} from '../agent/extensions/startup-banner.ts';

const theme = {
  fg: (_token: string, text: string) => text,
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

  void test('uses the SLOPPI name in compact banners', (t: TestContext) => {
    t.assert.deepStrictEqual(getBannerLines(48, theme), [
      '✦ SLOPPI  🍜 personal coding command center',
      '/chat [on|off]  ·  /sandbox  ·  /hotkeys',
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
