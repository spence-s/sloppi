import {describe, test, type TestContext} from 'node:test';
import {parsePipelineCommandInput} from '../agent/extensions/pipeline.ts';

void describe('pipeline command parsing', () => {
  void test('requires goal text', (t: TestContext) => {
    const result = parsePipelineCommandInput('');

    t.assert.strictEqual(result.ok, false);
  });

  void test('parses explicit plan mode', (t: TestContext) => {
    const result = parsePipelineCommandInput('plan add a safe pipeline');

    t.assert.deepStrictEqual(result, {
      ok: true,
      mode: 'plan',
      goal: 'add a safe pipeline',
    });
  });

  void test('defaults to run mode when no mode provided', (t: TestContext) => {
    const result = parsePipelineCommandInput('implement this feature');

    t.assert.deepStrictEqual(result, {
      ok: true,
      mode: 'run',
      goal: 'implement this feature',
    });
  });
});
