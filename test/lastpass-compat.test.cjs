'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { LASTPASS_ID, registerLastPassCompatibility } = require('../src/lastpass-compat.cjs');

test('LastPass IPC accepts only the approved installation in its browsing session', async () => {
  const scope = `chrome-extension://${LASTPASS_ID}/`;
  const serviceWorkers = new EventEmitter();
  const calls = [];
  const preloads = [];
  const messages = [];
  let frameHandler;
  let workerHandler;
  let approved = true;
  const worker = {
    scope,
    isDestroyed: () => false,
    ipc: { handle(channel, handler) { assert.equal(channel, 'relay:lastpass:call'); workerHandler = handler; } },
    send: (...args) => messages.push(args),
  };
  const browserSession = { serviceWorkers, registerPreloadScript: spec => preloads.push(spec) };
  serviceWorkers.getWorkerFromVersionID = id => id === 7 ? worker : { scope: 'https://site.example/' };
  serviceWorkers.getAllRunning = () => ({ 7: { scope }, 8: { scope: 'https://site.example/' } });

  const emit = registerLastPassCompatibility({
    ipcMain: { handle(channel, handler) { assert.equal(channel, 'relay:lastpass:call'); frameHandler = handler; } },
    browserSession,
    getExtension: id => approved && id === LASTPASS_ID,
    invoke: (...args) => { calls.push(args); return 'response'; },
  });
  assert.deepEqual(preloads.map(({ type, includeGlobs }) => [type, includeGlobs]), [
    ['frame', [scope + '*']], ['service-worker', [scope + '*']],
  ]);
  serviceWorkers.emit('running-status-changed', { versionId: 8, runningStatus: 'starting' });
  assert.equal(workerHandler, undefined);
  serviceWorkers.emit('running-status-changed', { versionId: 7, runningStatus: 'starting' });

  const contents = new EventEmitter();
  contents.session = browserSession;
  contents.isDestroyed = () => false;
  const trustedFrame = { url: scope + 'popup.html', send: (...args) => messages.push(args) };
  contents.mainFrame = { framesInSubtree: [trustedFrame, { url: 'https://site.example/', send: assert.fail }] };
  const frameEvent = { sender: contents, senderFrame: trustedFrame };
  const workerEvent = { session: browserSession, serviceWorker: worker };
  assert.throws(() => frameHandler({ ...frameEvent, senderFrame: { url: 'https://site.example/' + scope } }), /Untrusted/);
  assert.throws(() => frameHandler({ ...frameEvent, sender: { session: {} } }), /Untrusted/);
  assert.throws(() => workerHandler({ ...workerEvent, session: {} }), /Untrusted/);
  assert.throws(() => workerHandler({ ...workerEvent, serviceWorker: { scope: 'https://site.example/' } }), /Untrusted/);
  assert.equal(await frameHandler(frameEvent, 'tabs.query', [{}]), 'response');
  assert.equal(await workerHandler(workerEvent, 'windows.getAll', []), 'response');
  assert.deepEqual(calls, [['tabs.query', [{}]], ['windows.getAll', []]]);

  emit('windows.onFocusChanged', [3]);
  assert.deepEqual(messages, Array(2).fill(['relay:lastpass:event', 'windows.onFocusChanged', [3]]));
  approved = false;
  assert.throws(() => frameHandler(frameEvent), /Untrusted/);
  assert.throws(() => workerHandler(workerEvent), /Untrusted/);
  emit('windows.onFocusChanged', [-1]);
  assert.equal(messages.length, 2);
});
