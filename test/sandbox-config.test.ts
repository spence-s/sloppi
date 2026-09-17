import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {ConfigStore} from '../agent/extensions/sandbox/config.ts';

void test('edits network access and request policies as one destination', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configStore = new ConfigStore('/project', join(directory, 'sandbox.json'));
  const policy = configStore.validateRequestPolicy({
    destination: 'api.example.com:443',
    allow: [{methods: ['POST']}],
  });

  try {
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

void test('adds, replaces, and removes scoped request policies', async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'sloppi-config-test-'));
  const configStore = new ConfigStore('/project', join(directory, 'sandbox.json'));
  const globalPolicy = configStore.validateRequestPolicy({
    destination: 'api.example.com:443',
    allow: [{methods: ['GET']}],
  });
  const projectPolicy = configStore.validateRequestPolicy({
    destination: 'hooks.example.com:443',
    allow: [{pathPrefixes: ['/events']}],
  });
  const replacement = configStore.validateRequestPolicy({
    destination: 'hooks.example.com:443',
    allow: [{methods: ['POST'], paths: ['/events']}],
  });

  try {
    await configStore.updateRequestPolicy('global', 'add', globalPolicy);
    await configStore.updateRequestPolicy('project', 'add', projectPolicy);
    await configStore.updateRequestPolicy('project', 'replace', projectPolicy, replacement);

    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('global'), [globalPolicy]);
    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('project'), [replacement]);
    t.assert.deepStrictEqual(configStore.getRequestPolicies(), [globalPolicy, replacement]);
    await t.assert.rejects(
      configStore.updateRequestPolicy('project', 'replace', replacement),
      /requires its replacement/v,
    );

    await configStore.updateRequestPolicy('project', 'remove', replacement);
    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('project'), []);
    t.assert.deepStrictEqual(configStore.getScopedRequestPolicies('global'), [globalPolicy]);
  } finally {
    await rm(directory, {force: true, recursive: true});
  }
});
