import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {PermissionConfig} from '../agent/extensions/permissions/config.ts';
import {Permissions} from '../agent/extensions/permissions/index.ts';

/** Creates the minimum interactive context needed by the permission gate. */
function createContext(choice: string | undefined, hasUI = true, steering?: string): ExtensionContext {
  return {
    hasUI,
    ui: {
      input: async () => steering,
      select: async () => choice,
    },
  } as unknown as ExtensionContext;
}

void test('matches complete commands and remembers exact session approvals', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
  const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
  const steeringMessages: Array<{message: string; deliverAs: string | undefined}> = [];
  const permissions = new Permissions({
    /** Records steering without starting an agent turn during the test. */
    sendUserMessage(message: string, options?: {deliverAs?: string}) {
      steeringMessages.push({message, deliverAs: options?.deliverAs});
    },
  } as never, config);

  try {
    await config.replaceCommands('global', {
      '\\bgh\\s+repo\\s+delete\\b': 'deny',
      '\\b(?:gh|helm)\\b': 'ask',
    });

    t.assert.strictEqual(await permissions.check('npm test', createContext('Deny')), undefined);
    t.assert.deepStrictEqual(
      await permissions.check('gh repo delete owner/repo', createContext('Allow once')),
      {block: true, reason: String.raw`\bgh\s+repo\s+delete\b is denied by command permission policy.`},
    );
    t.assert.deepStrictEqual(
      await permissions.check('node -e \'execSync("gh repo view")\'', createContext('Deny')),
      {block: true, reason: 'Command blocked by user.'},
    );

    t.assert.deepStrictEqual(
      await permissions.check('helm uninstall app', createContext('Deny and steer…', true, '  inspect the release first  ')),
      {block: true, reason: 'Command blocked by user.'},
    );
    t.assert.deepStrictEqual(steeringMessages, [
      {message: 'inspect the release first', deliverAs: 'steer'},
    ]);

    t.assert.strictEqual(
      await permissions.check('helm list', createContext('Allow for this session')),
      undefined,
    );
    t.assert.strictEqual(await permissions.check('helm list', createContext('Deny')), undefined);
    t.assert.deepStrictEqual(
      await permissions.check('helm status app', createContext(undefined, false)),
      {
        block: true,
        reason: String.raw`Command permission required for \b(?:gh|helm)\b, but no confirmation UI is available.`,
      },
    );
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('persists regex policy and keeps global denials final', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
  const path = join(directory, 'permissions.json');
  const config = new PermissionConfig('/project', path);

  try {
    await config.replaceCommands('global', {'\\bgh\\b': 'deny', '\\bkubectl\\b': 'ask'});
    await config.replaceCommands('project', {'\\bgh\\b': 'ask', '\\bhelm\\b': 'ask'});
    await config.reload();

    t.assert.deepStrictEqual(config.getEffectiveCommands(), {
      '\\bgh\\b': 'deny',
      '\\bhelm\\b': 'ask',
      '\\bkubectl\\b': 'ask',
    });
    t.assert.deepStrictEqual(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
      {
        commands: {'\\bgh\\b': 'deny', '\\bkubectl\\b': 'ask'},
        projects: {'/project': {commands: {'\\bgh\\b': 'ask', '\\bhelm\\b': 'ask'}}},
      },
    );
    await t.assert.rejects(config.replaceCommands('project', {'[': 'ask'}), /Invalid permission regex/v);
    await t.assert.rejects(config.replaceCommands('project', {gh: 'allow'}), /Invalid permission decision/v);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('reloads externally edited policy before each decision', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
  const path = join(directory, 'permissions.json');
  const permissions = new Permissions({} as never, new PermissionConfig('/project', path));

  try {
    await writeFile(path, JSON.stringify({commands: {kubectl: 'deny'}}));
    t.assert.deepStrictEqual(
      await permissions.check('kubectl get pods', createContext('Allow once')),
      {block: true, reason: 'kubectl is denied by command permission policy.'},
    );
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
