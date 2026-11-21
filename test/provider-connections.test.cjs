const assert = require('node:assert/strict');
const test = require('node:test');
const { createProviderConnections } = require('../src/agent/provider-connections.cjs');

function setup({ approved = [], signedIn = [], installed = ['chatgpt', 'claude'], signIn, saveApproval } = {}) {
  const grants = new Set();
  const calls = [];
  const approvedIds = new Set(approved);
  const signedInIds = new Set(signedIn);
  const controller = createProviderConnections({
    tools: {
      find: async (id) => installed.includes(id) ? `${id}.exe` : null,
      checkAuth: async (id) => signedInIds.has(id),
      signIn: async (id, exe, options) => {
        calls.push(['signIn', id, exe]);
        if (signIn) await signIn(options);
        signedInIds.add(id);
      },
      open: async (id, exe, options) => calls.push(['open', id, exe, options])
    },
    bridge: {
      grantProvider: async (id) => {
        grants.add(id);
        return { url: 'http://127.0.0.1:8040/mcp', token: `secret-${id}` };
      },
      revokeProvider: async (id) => grants.delete(id)
    },
    getApproved: (id) => approvedIds.has(id),
    setApproved: (id, approve) => {
      if (saveApproval) saveApproval(id, approve);
      if (approve) approvedIds.add(id);
      else approvedIds.delete(id);
    },
    getWorkingDirectory: async () => 'Relay workspace'
  });
  return { controller, approvedIds, grants, calls, signedInIds };
}

test('first-party sign-in connects the selected agent and launches it with a local grant', async () => {
  const { controller, approvedIds, grants, calls } = setup({ signedIn: ['claude'] });
  await controller.refresh();
  assert.equal(controller.snapshot().chatgpt.status, 'available');
  assert.equal(grants.size, 0);
  await controller.connect('chatgpt');
  await controller.connect('claude');
  assert.deepEqual([...approvedIds], ['chatgpt', 'claude']);
  assert.deepEqual(calls, [['signIn', 'chatgpt', 'chatgpt.exe']]);
  await controller.open('chatgpt');
  assert.deepEqual(calls.at(-1), ['open', 'chatgpt', 'chatgpt.exe', {
    url: 'http://127.0.0.1:8040/mcp', token: 'secret-chatgpt', workingDirectory: 'Relay workspace'
  }]);
  assert.doesNotMatch(JSON.stringify(controller.snapshot()), /secret|127\.0\.0\.1/);
  await controller.disconnect('chatgpt');
  assert.deepEqual([...grants], ['claude']);
  assert.equal(controller.snapshot().claude.status, 'connected');
  assert.equal(controller.snapshot().chatgpt.status, 'available');
});

test('canceling sign-in leaves browser access disabled', async () => {
  let signInStarted;
  const started = new Promise((resolve) => { signInStarted = resolve; });
  const { controller, grants, approvedIds } = setup({
    signIn: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      signInStarted();
    })
  });
  const connect = controller.connect('claude');
  await started;
  assert.equal(controller.snapshot().claude.status, 'connecting');
  controller.cancel('claude');
  await connect;
  assert.equal(controller.snapshot().claude.status, 'available');
  assert.equal(grants.size, 0);
  assert.equal(approvedIds.size, 0);
});

test('only previously approved and signed-in providers reconnect after restart', async () => {
  const { controller, grants, calls, signedInIds } = setup({ approved: ['claude'], signedIn: ['claude'], installed: ['claude'] });
  await controller.refresh();
  assert.equal(controller.snapshot().chatgpt.status, 'missing');
  assert.equal(controller.snapshot().claude.status, 'connected');
  assert.deepEqual([...grants], ['claude']);
  assert.deepEqual(calls, []);
  signedInIds.clear();
  await controller.refresh();
  assert.equal(controller.snapshot().claude.status, 'available');
  assert.equal(grants.size, 0);
});

test('a failed local approval write revokes the grant', async () => {
  const { controller, grants } = setup({ signedIn: ['chatgpt'], saveApproval: () => { throw new Error('Write failed'); } });
  await assert.rejects(controller.connect('chatgpt'), /Relay couldn’t connect/);
  assert.equal(controller.snapshot().chatgpt.status, 'error');
  assert.equal(grants.size, 0);
});
