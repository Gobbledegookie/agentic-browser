'use strict';

const path = require('node:path');

const LASTPASS_ID = 'hdokiejnpimakedhajhdlcegeplioahd';
const LASTPASS_SCOPE = `chrome-extension://${LASTPASS_ID}/`;
const CALL = 'relay:lastpass:call';
const EVENT = 'relay:lastpass:event';

function isLastPassPage(value) {
  return typeof value === 'string' && value.startsWith(LASTPASS_SCOPE);
}

function registerLastPassCompatibility({ ipcMain, browserSession, getExtension, invoke }) {
  const workers = browserSession.serviceWorkers;
  const attached = new WeakSet();
  const frameContents = new Set();
  const preload = path.join(__dirname, 'lastpass-preload.cjs');

  for (const type of ['frame', 'service-worker']) {
    browserSession.registerPreloadScript({ type, filePath: preload, includeGlobs: [LASTPASS_SCOPE + '*'] });
  }

  async function call(method, args) {
    try {
      return await invoke(method, args);
    } catch {
      throw new Error('Relay could not complete this extension request.');
    }
  }

  ipcMain.handle(CALL, (event, method, args) => {
    const contents = event.sender;
    if (contents.session !== browserSession || !isLastPassPage(event.senderFrame?.url) || !getExtension(LASTPASS_ID)) {
      throw new Error('Untrusted extension frame.');
    }
    if (!frameContents.has(contents)) {
      frameContents.add(contents);
      contents.once('destroyed', () => frameContents.delete(contents));
    }
    return call(method, args);
  });

  workers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return;
    const worker = workers.getWorkerFromVersionID(versionId);
    if (!worker || worker.scope !== LASTPASS_SCOPE || attached.has(worker)) return;
    attached.add(worker);
    worker.ipc.handle(CALL, (event, method, args) => {
      if (event.session !== browserSession || event.serviceWorker.scope !== LASTPASS_SCOPE || !getExtension(LASTPASS_ID)) {
        throw new Error('Untrusted extension worker.');
      }
      return call(method, args);
    });
  });

  function sendToWorker(name, args) {
    let sent = false;
    for (const [id, info] of Object.entries(workers.getAllRunning())) {
      if (info.scope !== LASTPASS_SCOPE) continue;
      const worker = workers.getWorkerFromVersionID(Number(id));
      if (!worker || worker.isDestroyed() || worker.scope !== LASTPASS_SCOPE) continue;
      try {
        worker.send(EVENT, name, args);
        sent = true;
      } catch { /* The worker may have just stopped. */ }
    }
    return sent;
  }

  return function emit(name, args) {
    if (!getExtension(LASTPASS_ID)) return;
    if (!sendToWorker(name, args) && name === 'contextMenus.onClicked') {
      void workers.startWorkerForScope(LASTPASS_SCOPE).then(() => {
        if (getExtension(LASTPASS_ID)) sendToWorker(name, args);
      }).catch(() => {});
    }
    for (const contents of frameContents) {
      if (contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame?.framesInSubtree ?? []) {
        if (frame.detached || !isLastPassPage(frame.url)) continue;
        try { frame.send(EVENT, name, args); } catch { /* The frame may be navigating. */ }
      }
    }
  };
}

module.exports = { LASTPASS_ID, isLastPassPage, registerLastPassCompatibility };
