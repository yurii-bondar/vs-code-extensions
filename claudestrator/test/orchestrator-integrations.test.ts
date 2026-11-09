// The window's integrations: which MCP server reads a tracker's tickets, and Bitbucket's credentials.
import test from 'node:test';
import * as assert from 'node:assert/strict';
import Module from 'module';

import type { McpServer } from '../src/core/wire';

/** VS Code's settings and secret storage, as far as these methods use them. */
const values = new Map<string, unknown>();
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (key: string) => values.get(key), update: async (key: string, value: unknown) => void values.set(key, value) }) },
  ConfigurationTarget: { Global: 1 },
};
/* eslint-disable @typescript-eslint/no-require-imports */
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const load = loader._load;
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};
const { Orchestrator } = require('../src/orchestrator') as typeof import('../src/orchestrator');
loader._load = load;

const server = (name: string, state = 'connected', extra: Partial<McpServer> = {}): McpServer => ({ name, scope: 'user', state, ...extra });

function orchestrator(servers: McpServer[], checked = true) {
  const secrets = new Map<string, string>();
  const orch = Object.assign(Object.create(Orchestrator.prototype) as InstanceType<typeof Orchestrator>, {
    mcp: { servers, checking: false, checkedAt: checked ? new Date().toISOString() : null, error: null },
    context: { secrets: { store: async (k: string, v: string) => void secrets.set(k, v), delete: async (k: string) => void secrets.delete(k), get: async (k: string) => secrets.get(k) } },
  });
  return { orch, secrets };
}

test('orchestrator: Linear tickets are read with the Linear MCP server, Jira ones with the Atlassian one', async () => {
  values.clear();
  values.set('atlassian.site', 'acme.atlassian.net');
  const { orch } = orchestrator([server('Atlassian'), server('linear-work'), server('linear-old', 'needs_auth')]);
  assert.deepEqual(await orch.mcpIntakeServer('linear'), { server: 'linear-work', site: undefined });
  assert.deepEqual(await orch.mcpIntakeServer('atlassian'), { server: 'Atlassian', site: 'acme.atlassian.net' });
  assert.deepEqual(await orch.mcpIntakeServer(), { server: 'Atlassian', site: 'acme.atlassian.net' }, 'Atlassian unless asked otherwise');

  const none = orchestrator([server('Atlassian'), server('linear', 'failed'), server('linear-off', 'connected', { disabled: true })]).orch;
  assert.equal(await none.mcpIntakeServer('linear'), null, 'one that failed or is off is not used');
  const unchecked = orchestrator([server('Linear', 'installed')], false).orch;
  assert.deepEqual(await unchecked.mcpIntakeServer('linear'), { server: 'Linear', site: undefined }, 'before the first check, a configured one');
});

test("orchestrator: Bitbucket's token is kept in secret storage, with its email or the Jira one", async () => {
  values.clear();
  const env = { BITBUCKET_EMAIL: process.env.BITBUCKET_EMAIL, BITBUCKET_API_TOKEN: process.env.BITBUCKET_API_TOKEN, ATLASSIAN_EMAIL: process.env.ATLASSIAN_EMAIL };
  delete process.env.BITBUCKET_EMAIL;
  delete process.env.BITBUCKET_API_TOKEN;
  delete process.env.ATLASSIAN_EMAIL;
  try {
    const { orch, secrets } = orchestrator([]);
    assert.equal(orch.bitbucketAuth(), null);
    assert.equal(orch.bitbucket(), null);

    values.set('atlassian.email', 'dev@acme.com');
    await orch.saveBitbucket({ email: '', token: 'bb-token-1' });
    assert.equal(secrets.get('claudestrator.bitbucketToken'), 'bb-token-1');
    assert.deepEqual(orch.bitbucketAuth(), { email: 'dev@acme.com', token: 'bb-token-1' }, "the Jira email when it has none of its own");

    await orch.saveBitbucket({ email: 'ci@acme.com' });
    assert.deepEqual(orch.bitbucketAuth(), { email: 'ci@acme.com', token: 'bb-token-1' }, 'no token given: the saved one stays');
    assert.equal(orch.bitbucket()!.auth.email, 'ci@acme.com');

    await orch.saveBitbucket({ email: 'ci@acme.com', token: '' });
    assert.equal(secrets.has('claudestrator.bitbucketToken'), false, 'forgotten');
    assert.equal(orch.bitbucketAuth(), null);

    process.env.BITBUCKET_API_TOKEN = 'from-env';
    assert.deepEqual(orch.bitbucketAuth(), { email: 'ci@acme.com', token: 'from-env' });
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
