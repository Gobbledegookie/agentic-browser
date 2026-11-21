const PROVIDERS = Object.freeze({
  chatgpt: { label: 'ChatGPT', installUrl: 'https://learn.chatgpt.com/docs/cli' },
  claude: { label: 'Claude', installUrl: 'https://code.claude.com/docs/en/setup' }
});

function createProviderConnections({ tools, bridge, getApproved, setApproved, getWorkingDirectory, onChange = () => {} }) {
  const records = new Map(Object.keys(PROVIDERS).map((id) => [id, { status: 'checking' }]));
  let closing = false;

  function requireProvider(id) {
    if (!records.has(id)) throw new TypeError('Choose ChatGPT or Claude.');
    return records.get(id);
  }

  function snapshot() {
    return Object.fromEntries([...records].map(([id, { status, message }]) => [id, { status, message }]));
  }

  function status(record, next, message) {
    record.status = next;
    record.message = message;
    onChange();
  }

  function run(id, kind, work) {
    const record = requireProvider(id);
    if (closing) throw new Error('Relay is closing.');
    if (record.operation?.kind === kind) return record.operation.promise;
    if (record.operation) throw new Error('Wait for the current connection step to finish.');
    const controller = new AbortController();
    const operation = { kind, controller };
    record.operation = operation;
    operation.promise = Promise.resolve().then(() => work(record, controller.signal)).catch(async (error) => {
      if (controller.signal.aborted) {
        status(record, record.executable ? 'available' : 'checking');
        return;
      }
      if (kind === 'check') await bridge.revokeProvider(id).catch(() => {});
      const message = error.publicMessage || `Relay couldn’t ${kind === 'open' ? 'open' : 'connect to'} ${PROVIDERS[id].label}. Try again.`;
      if (record.status !== 'missing') {
        status(record, kind === 'open' && record.status === 'connected' ? 'connected' : 'error', message);
      }
      throw new Error(message, { cause: error });
    }).finally(() => { record.operation = undefined; });
    return operation.promise;
  }

  async function find(id, record, signal) {
    record.executable = await tools.find(id);
    signal.throwIfAborted();
    if (!record.executable) status(record, 'missing');
    return record.executable;
  }

  function refreshOne(id) {
    const current = requireProvider(id);
    if (current.operation || closing) return;
    return run(id, 'check', async (record, signal) => {
      if (record.status !== 'connected') status(record, 'checking');
      const executable = await find(id, record, signal);
      if (!executable || !getApproved(id)) {
        await bridge.revokeProvider(id);
        if (executable) status(record, 'available');
        return;
      }
      const signedIn = await tools.checkAuth(id, executable, { signal });
      signal.throwIfAborted();
      if (!signedIn) {
        await bridge.revokeProvider(id);
        status(record, 'available');
        return;
      }
      await bridge.grantProvider(id);
      status(record, 'connected');
    });
  }

  async function refresh() {
    await Promise.allSettled(Object.keys(PROVIDERS).map(refreshOne));
  }

  function connect(id) {
    return run(id, 'connect', async (record, signal) => {
      if (record.status === 'connected') return;
      status(record, 'connecting');
      const executable = await find(id, record, signal);
      if (!executable) return;
      const signedIn = await tools.checkAuth(id, executable, { signal });
      signal.throwIfAborted();
      if (!signedIn) {
        await tools.signIn(id, executable, { signal, workingDirectory: await getWorkingDirectory() });
        signal.throwIfAborted();
        if (!await tools.checkAuth(id, executable, { signal })) {
          const error = new Error('Provider sign-in did not finish.');
          error.publicMessage = `Finish signing in to ${PROVIDERS[id].label}, then try again.`;
          throw error;
        }
      }
      signal.throwIfAborted();
      await bridge.grantProvider(id);
      try {
        signal.throwIfAborted();
        setApproved(id, true);
      } catch (error) {
        await bridge.revokeProvider(id);
        throw error;
      }
      status(record, 'connected');
    });
  }

  function open(id) {
    if (requireProvider(id).status !== 'connected' || !getApproved(id)) throw new Error('Connect the agent first.');
    return run(id, 'open', async (record, signal) => {
      const executable = await find(id, record, signal);
      if (!executable) {
        await bridge.revokeProvider(id);
        return;
      }
      if (!await tools.checkAuth(id, executable, { signal })) {
        await bridge.revokeProvider(id);
        status(record, 'available', 'Sign in again to open this agent.');
        return;
      }
      const workingDirectory = await getWorkingDirectory();
      signal.throwIfAborted();
      const connection = await bridge.grantProvider(id);
      signal.throwIfAborted();
      await tools.open(id, executable, { ...connection, workingDirectory });
      status(record, 'connected');
    });
  }

  function disconnect(id) {
    return run(id, 'disconnect', async (record) => {
      setApproved(id, false);
      await bridge.revokeProvider(id);
      status(record, record.executable ? 'available' : 'missing');
    });
  }

  function cancel(id) {
    const { operation } = requireProvider(id);
    if (operation?.kind === 'connect') operation.controller.abort();
  }

  async function stop() {
    closing = true;
    const pending = [...records.values()].map((record) => record.operation).filter(Boolean);
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled(pending.map((operation) => operation.promise));
  }

  function installUrl(id) {
    requireProvider(id);
    return PROVIDERS[id].installUrl;
  }

  return { snapshot, refresh, connect, open, disconnect, cancel, stop, installUrl };
}

module.exports = { createProviderConnections, PROVIDERS };
