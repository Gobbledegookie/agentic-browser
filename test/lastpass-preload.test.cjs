'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const extensionId = 'hdokiejnpimakedhajhdlcegeplioahd';
const preload = readFileSync(join(__dirname, '../src/lastpass-preload.cjs'), 'utf8');

function runPreload({ origin = 'chrome-extension:', id = extensionId } = {}) {
  const nativeMessage = () => 'native message';
  const nativeScript = () => 'native script';
  const chrome = { runtime: { id }, tabs: { sendMessage: nativeMessage }, scripting: { executeScript: nativeScript } };
  const page = { location: { protocol: origin, hostname: extensionId }, chrome, browser: {}, crypto: { randomUUID } };
  const calls = [];
  const ipc = new EventEmitter();
  ipc.invoke = async (channel, method, args) => {
    calls.push({ channel, method, args: structuredClone(args) });
    if (method === 'cookies.get') throw new Error('Private diagnostics');
    return method === 'tabs.query' ? [{ id: 7, active: true }] : undefined;
  };
  const contextBridge = {
    executeInMainWorld({ func, args }) {
      return runInNewContext('(' + func.toString() + ')(...input)', Object.assign(page, { input: args }));
    },
    exposeInMainWorld(name, value) { page[name] = value; }
  };
  runInNewContext(preload, { process: { type: 'service-worker' }, require: () => ({ contextBridge, ipcRenderer: ipc }) });
  return { page, calls, ipc, nativeMessage, nativeScript };
}

test('only the LastPass extension origin and runtime ID get the compatibility API', () => {
  for (const options of [{ origin: 'https:' }, { id: 'another-extension' }]) {
    const { page, calls, ipc } = runPreload(options);
    assert.equal(page.chrome.windows, undefined);
    assert.notEqual(page.browser, page.chrome);
    assert.equal(ipc.listenerCount('relay:lastpass:event'), 0);
    assert.equal(calls.length, 0);
  }
});

test('the MV3 worker alias preserves native extension APIs and supports callbacks and promises', async () => {
  const { page: { chrome, browser }, calls, nativeMessage, nativeScript } = runPreload();
  assert.equal(browser, chrome);
  assert.equal(chrome.tabs.sendMessage, nativeMessage);
  assert.equal(chrome.scripting.executeScript, nativeScript);
  assert.equal(chrome.action, chrome.browserAction);
  assert.equal(chrome.cookies.set, undefined);

  assert.deepEqual(await chrome.tabs.query({ active: true }), [{ id: 7, active: true }]);
  await new Promise(resolve => chrome.tabs.query({ active: true }, value => {
    assert.deepEqual(value, [{ id: 7, active: true }]);
    resolve();
  }));
  assert.deepEqual(calls[0], { channel: 'relay:lastpass:call', method: 'tabs.query', args: [{ active: true }] });
  await new Promise(resolve => chrome.cookies.get({ url: 'https://lastpass.com/', name: 'test-cookie' }, value => {
    assert.equal(value, undefined);
    assert.match(chrome.runtime.lastError.message, /could not complete/);
    assert.doesNotMatch(chrome.runtime.lastError.message, /Private diagnostics/);
    resolve();
  }));
  assert.equal(chrome.runtime.lastError, undefined);
});

test('context menu creation returns a synchronous ID and events carry only their payload', async () => {
  const { page: { chrome }, calls, ipc } = runPreload();
  const itemId = await new Promise(resolve => {
    const id = chrome.contextMenus.create({ title: 'Test' }, () => resolve(id));
    assert.equal(typeof id, 'string');
  });
  assert.deepEqual(calls[0], { channel: 'relay:lastpass:call', method: 'contextMenus.create', args: [{ title: 'Test', id: itemId }] });

  const seen = [];
  const focusChanged = chrome.windows.onFocusChanged;
  const listener = id => seen.push(id);
  focusChanged.addListener(listener);
  assert.equal(focusChanged.hasListener(listener), true);
  ipc.emit('relay:lastpass:event', { sender: 'internal' }, 'windows.onFocusChanged', [123]);
  ipc.emit('relay:lastpass:event', { sender: 'internal' }, 'windows.onFocusChanged', 'invalid payload');
  ipc.emit('relay:lastpass:event', { sender: 'internal' }, 'unknown.onFocusChanged', [456]);
  focusChanged.removeListener(listener);
  ipc.emit('relay:lastpass:event', { sender: 'internal' }, 'windows.onFocusChanged', [789]);
  assert.deepEqual(seen, [123]);
  assert.equal(focusChanged.hasListeners(), false);
});
