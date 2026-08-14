import {describe, test, type TestContext} from 'node:test';
import {getBannerLines} from '../agent/extensions/startup-banner.ts';

const theme = {
  fg: (_token: string, text: string) => text,
};

void describe('startup-banner', () => {
  void test('uses the SLOPPI logo in the wide banner', (t: TestContext) => {
    const banner = getBannerLines(72, theme).join('\n');

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
});
