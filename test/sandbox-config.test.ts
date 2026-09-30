import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {ConfigStore} from '../agent/extensions/sandbox/config.ts';

/**
 Verifies local connections can be configured independently for global and project scopes.
 */
void test('persists scoped local-connection settings', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-local-connections-test-'));
  const configStore = new ConfigStore('/project', join(directory, 'sandbox.json'));

  try {
    await configStore.setAllowLocalBinding('global', true);
    t.assert.strictEqual(configStore.getEffectiveConfig().network?.allowLocalBinding, true);

    await configStore.setAllowLocalBinding('project', false);
    t.assert.strictEqual(configStore.getEffectiveConfig().network?.allowLocalBinding, false);

    await configStore.reload();
    t.assert.strictEqual(configStore.getScopedSrtConfig('global').network?.allowLocalBinding, true);
    t.assert.strictEqual(configStore.getScopedSrtConfig('project').network?.allowLocalBinding, false);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});

void test('edits network access and request policies as one destination', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configStore = new ConfigStore('/project', join(directory, 'sandbox.json'));
  const policy = configStore.validateRequestPolicy({
    destination: 'api.example.com:443',
    allow: [{methods: ['POST']}],
  });

  try {
    t.assert.throws(
      () => {
        configStore.validateNetworkDestination({destination: ':443', permission: 'allow'});
      },
      /Invalid network destination/v,
    );
    await configStore.setNetworkDestination('project', {
      destination: policy.destination,
      permission: 'allow',
      policy,
    });
    t.assert.deepStrictEqual(configStore.getScopedSrtConfig('project').network?.allowedDomains, [policy.destination]);
    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('project'), [policy]);

    await configStore.setNetworkDestination('project', {destination: policy.destination, permission: 'deny'});
    t.assert.deepStrictEqual(configStore.getScopedSrtConfig('project').network?.allowedDomains, []);
    t.assert.deepStrictEqual(configStore.getScopedSrtConfig('project').network?.deniedDomains, [policy.destination]);
    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('project'), []);

    await configStore.removeNetworkDestination('project', policy.destination);
    t.assert.deepStrictEqual(configStore.getScopedSrtConfig('project').network?.deniedDomains, []);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
