import {describe, test, type TestContext} from 'node:test';
import {getOsLabel, parseGitStatus} from '../agent/extensions/status-line.ts';

void describe('status line', () => {
  void test('labels the host operating system', (t: TestContext) => {
    t.assert.strictEqual(getOsLabel('darwin'), ' macOS');
    t.assert.strictEqual(getOsLabel('linux'), ' Ubuntu');
  });

  void test('counts staged, modified, and untracked files', (t: TestContext) => {
    t.assert.deepStrictEqual(
      parseGitStatus('M  staged.ts\n M modified.ts\nMM both.ts\n?? new.ts\n'),
      {staged: 2, modified: 2, untracked: 1},
    );
  });
});
