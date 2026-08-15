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
function createContext(choice: string | undefined, hasUI = true): ExtensionContext {
  return {
    hasUI,
    ui: {
      select: async () => choice,
    },
  } as unknown as ExtensionContext;
}

void test('asks for sensitive commands and remembers exact session approvals', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
  const config = new PermissionConfig('/project', join(directory, 'permissions.json'));
  const permissions = new Permissions({} as never, config);

  try {
    t.assert.strictEqual(await permissions.check('npm test', createContext('Deny')), undefined);
    t.assert.deepStrictEqual(
      await permissions.check('/usr/local/bin/kubectl get pods && echo done', createContext('Deny')),
      {block: true, reason: 'Command blocked by user.'},
    );

    t.assert.strictEqual(
      await permissions.check('helm list', createContext('Allow for this session')),
      undefined,
    );
    t.assert.strictEqual(await permissions.check('helm list', createContext('Deny')), undefined);
    t.assert.deepStrictEqual(
      await permissions.check('helm status app', createContext(undefined, false)),
      {
        block: true,
        reason: 'Command permission required for helm, but no confirmation UI is available.',
      },
    );
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('persists scoped policy and keeps global denials final', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-permissions-test-'));
  const path = join(directory, 'permissions.json');
  const config = new PermissionConfig('/project', path);

  try {
    await config.replaceCommands('global', {kubectl: 'deny', helm: 'ask'});
    await config.replaceCommands('project', {kubectl: 'allow', helm: 'allow'});
    await config.reload();

    t.assert.deepStrictEqual(config.getEffectiveCommands(), {
      helm: 'allow',
      kubectl: 'deny',
      terraform: 'ask',
    });
    t.assert.deepStrictEqual(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
      {
        commands: {kubectl: 'deny', helm: 'ask'},
        projects: {'/project': {commands: {kubectl: 'allow', helm: 'allow'}}},
      },
    );
    await t.assert.rejects(config.replaceCommands('project', {kubectl: 'sometimes'}), /Invalid permission rule/v);
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
