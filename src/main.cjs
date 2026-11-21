const {
  app, BrowserWindow, WebContentsView, Menu, session, protocol, net,
  ipcMain, clipboard, dialog, shell
} = require('electron');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createProfile, webURL, resolveAddress, MAX_HISTORY } = require('./profile.cjs');
const { createAgentBridge } = require('./agent/bridge.cjs');
const { validatePreferencesPatch } = require('./agent/preferences.cjs');
const { createExtensionManager } = require('./extensions.cjs');

const APP_URL = 'relay://shell/index.html';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const MAX_TABS = 100;
const PERMISSIONS = new Map([
  ['media', 'use your camera or microphone'],
  ['geolocation', 'access your location'],
  ['notifications', 'show notifications'],
  ['clipboard-read', 'read from your clipboard']
]);

app.setName('Relay Browser');
app.enableSandbox();
app.setAppUserModelId('org.relaybrowser.desktop');
protocol.registerSchemesAsPrivileged([{ scheme: 'relay', privileges: { standard: true, secure: true } }]);

let win;
let profile;
let browserSession;
let extensions;
let agent;
let discoveryPath;
let activeTabId;
let visibleView;
let viewport;
let pendingBroadcast = false;
let saveTimer;
let closing = false;
let agentTransition = Promise.resolve();
let stoppingAgent = false;
let agentStopped = false;
const tabs = [];
const closedTabs = [];
const activeDownloads = new Map();

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId);
}

function saveSoon() {
  if (closing || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try { saveProfile(); } catch (error) { console.error('Saving Relay profile:', error); }
  }, 400);
  saveTimer.unref();
}

function saveProfile() {
  profile.data.lastSession = tabs.filter((tab) => !tab.url || webURL(tab.url)).map((tab) => ({
    url: tab.url, pinned: tab.pinned, active: tab.id === activeTabId
  }));
  profile.save();
}

function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}

function broadcast() {
  if (pendingBroadcast || closing || !win || win.isDestroyed()) return;
  pendingBroadcast = true;
  setImmediate(() => {
    pendingBroadcast = false;
    if (!closing && win && !win.isDestroyed()) send('relay:state', getState());
  });
}

function getState() {
  const mcpPath = app.isPackaged ? path.join(process.resourcesPath, 'agent', 'mcp.cjs') : path.join(__dirname, 'agent', 'mcp.cjs');
  return {
    tabs: tabs.map(({ view, findRequestId, ...tab }) => {
      const wc = view?.webContents;
      const live = wc && !wc.isDestroyed();
      return {
        ...tab,
        loading: Boolean(live && wc.isLoading()),
        canGoBack: Boolean(live && wc.navigationHistory.canGoBack()),
        canGoForward: Boolean(live && wc.navigationHistory.canGoForward()),
        zoomFactor: live ? wc.getZoomFactor() : 1,
        muted: Boolean(live && wc.isAudioMuted()),
        audible: Boolean(live && wc.isCurrentlyAudible())
      };
    }),
    activeTabId,
    preferences: { ...profile.data.preferences },
    bookmarks: profile.data.bookmarks,
    history: profile.data.history,
    downloads: profile.data.downloads.map(({ file, ...download }) => download),
    extensions: extensions.list(),
    agent: { ...agent.status(), mcpCommand: 'node', mcpArgs: [mcpPath], mcpEnv: { RELAY_AGENT_FILE: discoveryPath } },
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    version: app.getVersion()
  };
}

function updatePreferences(patch) {
  if (closing) throw new Error('Relay is closing.');
  const previous = profile.data.preferences;
  profile.data.preferences = { ...previous, ...validatePreferencesPatch(patch) };
  try { saveProfile(); } catch (error) {
    profile.data.preferences = previous;
    throw error;
  }
  broadcast();
  return { ...profile.data.preferences };
}

function setViewport(bounds) {
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) return;
  viewport = bounds;
  updateView();
}

function updateView(focus = false) {
  if (!win || win.isDestroyed()) return;
  const tab = activeTab();
  const [width, height] = win.getContentSize();
  const x = Math.max(0, Math.min(width, Math.round(viewport?.x ?? 0)));
  const y = Math.max(0, Math.min(height, Math.round(viewport?.y ?? 0)));
  const w = Math.min(width - x, Math.round(viewport?.width ?? 0));
  const h = Math.min(height - y, Math.round(viewport?.height ?? 0));
  const target = w > 0 && h > 0 && tab && tab.url && !tab.error ? tab.view : null;
  if (visibleView !== target) {
    if (visibleView) win.contentView.removeChildView(visibleView);
    visibleView = target;
    if (target) win.contentView.addChildView(target);
  }
  if (target) {
    target.setBounds({ x, y, width: w, height: h });
    if (focus) target.webContents.focus();
  } else if (focus) {
    win.webContents.focus();
  }
}

function extensionPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' && extensions.list().some((extension) => extension.enabled && extension.id === parsed.hostname);
  } catch { return false; }
}

function recordVisit(tab, url) {
  if (!webURL(url)) return;
  const history = profile.data.history;
  if (history[0]?.url === url && history[0].tabId === tab.id) return;
  history.unshift({ id: randomUUID(), tabId: tab.id, title: new URL(url).hostname, url, visitedAt: new Date().toISOString() });
  history.length = Math.min(history.length, MAX_HISTORY);
  saveSoon();
}

function setNavigated(tab, url, sameDocument = false) {
  if (!webURL(url) && !extensionPage(url)) return;
  if (!sameDocument) tab.title = new URL(url).hostname;
  tab.url = url;
  tab.error = '';
  recordVisit(tab, url);
  updateView();
  broadcast();
  saveSoon();
}

function installContextMenu(tab) {
  const wc = tab.view.webContents;
  wc.on('context-menu', (_event, params) => {
    if (tab !== activeTab()) return;
    const items = [];
    const link = webURL(params.linkURL)?.href;
    if (link) items.push(
      { label: 'Open link in new tab', click: () => attempt(() => addTab(link)) },
      { label: 'Copy link address', click: () => clipboard.writeText(link) },
      { type: 'separator' }
    );
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    else items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { label: 'Print…', click: () => wc.print() }
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function attachView(tab) {
  if (tab.view && !tab.view.webContents.isDestroyed()) return;
  tab.view = new WebContentsView({ webPreferences: {
    session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webviewTag: false, spellcheck: true, navigateOnDragDrop: false
  } });
  const wc = tab.view.webContents;
  const pageNavigation = (event) => {
    if (webURL(event.url)) return;
    if (extensionPage(event.url) && extensionPage(wc.getURL()) && new URL(event.url).origin === new URL(wc.getURL()).origin && new URL(event.url).hostname === new URL(wc.getURL()).hostname) return;
    event.preventDefault();
  };
  wc.on('will-navigate', pageNavigation);
  wc.on('will-redirect', (event) => { if (event.isMainFrame) pageNavigation(event); });
  wc.on('content-bounds-updated', (event) => event.preventDefault());
  wc.setWindowOpenHandler(({ url, disposition, postBody }) => {
    if (webURL(url) && !postBody) setImmediate(() => attempt(() => addTab(url, { activate: disposition !== 'background-tab' })));
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('did-navigate', (_event, url) => setNavigated(tab, url));
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) setNavigated(tab, url, true); });
  wc.on('page-title-updated', (_event, title) => {
    if (!tab.url || tab.error) return;
    tab.title = title.trim().slice(0, 300) || new URL(tab.url).hostname;
    const visit = profile.data.history.find((item) => item.tabId === tab.id && item.url === tab.url);
    if (visit) visit.title = tab.title;
    broadcast();
    saveSoon();
  });
  wc.on('did-start-loading', broadcast);
  wc.on('did-stop-loading', broadcast);
  wc.on('audio-state-changed', broadcast);
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && (webURL(url) || extensionPage(url))) {
      tab.url = url;
      tab.error = description || 'The page could not be loaded.';
      updateView();
      broadcast();
    }
  });
  wc.on('render-process-gone', () => {
    if (closing) return;
    tab.error = 'This page stopped responding. Reload to try again.';
    updateView();
    broadcast();
  });
  wc.on('enter-html-full-screen', () => { if (tab === activeTab() && !win.isFullScreen()) win.setFullScreen(true); });
  wc.on('leave-html-full-screen', () => { if (tab === activeTab() && win.isFullScreen()) win.setFullScreen(false); });
  wc.on('found-in-page', (_event, result) => {
    if (tab === activeTab() && tab.findRequestId === result.requestId) send('relay:find', result);
  });
  installContextMenu(tab);
  installShortcuts(wc);
}

function navigate(tab, url) {
  if (!webURL(url) && !extensionPage(url)) throw new Error('This address cannot be opened.');
  attachView(tab);
  tab.url = url;
  tab.title = new URL(url).hostname;
  tab.error = '';
  updateView(tab === activeTab());
  void tab.view.webContents.loadURL(url).catch((error) => {
    if (error.code === 'ERR_ABORTED' || !tabs.includes(tab) || tab.url !== url || tab.error) return;
    tab.error = error.code || 'The page could not be loaded.';
    updateView();
    broadcast();
  });
  broadcast();
  saveSoon();
}

function selectTab(tab, focus = true) {
  activeTabId = tab.id;
  if (tab.url && !tab.view && !tab.error) navigate(tab, tab.url);
  updateView(focus);
  broadcast();
  saveSoon();
}

function addTab(url = '', { activate = true, pinned = false, lazy = false } = {}) {
  if (tabs.length >= MAX_TABS) throw new Error('Close a tab before opening another.');
  const tab = { id: randomUUID(), title: 'New tab', url: '', error: '', pinned };
  const firstUnpinned = tabs.findIndex((item) => !item.pinned);
  if (pinned && firstUnpinned !== -1) tabs.splice(firstUnpinned, 0, tab);
  else tabs.push(tab);
  if (url && lazy) Object.assign(tab, { url, title: new URL(url).hostname });
  else if (url) navigate(tab, url);
  if (activate) selectTab(tab);
  else broadcast();
  return tab;
}

function closeTab(tab, remember = true) {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  if (remember && webURL(tab.url)) {
    closedTabs.unshift({ url: tab.url, pinned: tab.pinned });
    closedTabs.length = Math.min(closedTabs.length, 25);
  }
  tabs.splice(index, 1);
  if (tab.id === activeTabId) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) selectTab(next);
    else addTab();
  }
  tab.view?.webContents.close();
  broadcast();
  saveSoon();
}

function pinTab(tab) {
  tabs.splice(tabs.indexOf(tab), 1);
  tab.pinned = !tab.pinned;
  const boundary = tabs.findIndex((item) => !item.pinned);
  tabs.splice(boundary === -1 ? tabs.length : boundary, 0, tab);
  saveSoon();
}

function goHome(tab) {
  const home = profile.data.preferences.homepage;
  if (home) return navigate(tab, home);
  const view = tab.view;
  Object.assign(tab, { view: undefined, url: '', title: 'New tab', error: '' });
  updateView(true);
  view?.webContents.close();
  saveSoon();
}

function trackDownload(item, wc) {
  const id = randomUUID();
  const download = { id, name: item.getFilename(), state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes(), file: '' };
  profile.data.downloads.unshift(download);
  profile.data.downloads.length = Math.min(profile.data.downloads.length, 100);
  activeDownloads.set(id, item);
  const update = (state) => {
    Object.assign(download, { state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), file: item.getSavePath() });
    broadcast();
    saveSoon();
  };
  item.on('updated', (_event, state) => update(state));
  item.once('done', (_event, state) => { update(state); activeDownloads.delete(id); });
  if (wc === activeTab()?.view?.webContents) send('relay:command', 'showDownloads');
  broadcast();
}

function configurePermissions(ses) {
  const allowed = new Set();
  const pending = new Map();
  function key(permission, origin) {
    const url = webURL(origin);
    return url?.protocol === 'https:' && PERMISSIONS.has(permission) ? `${url.origin} ${permission}` : null;
  }
  ses.setPermissionCheckHandler((_webContents, permission, origin) => {
    if (permission === 'fullscreen') return Boolean(webURL(origin));
    return allowed.has(key(permission, origin));
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = webURL(details.requestingUrl || wc.getURL());
    if (permission === 'fullscreen') return callback(Boolean(origin));
    const permissionKey = key(permission, origin?.href);
    if (!permissionKey || wc !== activeTab()?.view?.webContents || details.isMainFrame === false || origin.origin !== webURL(wc.getURL())?.origin) return callback(false);
    if (allowed.has(permissionKey)) return callback(true);
    if (!pending.has(permissionKey)) {
      const request = dialog.showMessageBox(win, {
        type: 'question', title: 'Website permission', message: `Allow ${origin.hostname} to ${PERMISSIONS.get(permission)}?`,
        detail: 'This choice applies until you quit Relay Browser.', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, noLink: true
      }).then(({ response }) => {
        if (response !== 1 || wc.isDestroyed() || webURL(wc.getURL())?.origin !== origin.origin) return false;
        allowed.add(permissionKey);
        return true;
      }).catch(() => false).finally(() => pending.delete(permissionKey));
      pending.set(permissionKey, request);
    }
    void pending.get(permissionKey).then(callback);
  });
  ses.setDevicePermissionHandler(() => false);
}

function requireTab(id = activeTabId) {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) throw new Error('This tab is no longer open.');
  return tab;
}

async function setAgent(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable the agent connection.');
  const previous = profile.data.agentEnabled;
  if (enabled) await agent.start();
  else await agent.stop();
  profile.data.agentEnabled = enabled;
  try { saveProfile(); } catch (error) {
    profile.data.agentEnabled = previous;
    if (previous) await agent.start();
    else await agent.stop();
    throw error;
  }
}

function changeAgent(work) {
  const result = agentTransition.then(work);
  agentTransition = result.catch(() => {});
  return result;
}

function toggleBookmark(tab) {
  if (!webURL(tab.url)) throw new Error('Open a webpage before bookmarking it.');
  const bookmarks = profile.data.bookmarks;
  const index = bookmarks.findIndex((item) => item.url === tab.url);
  if (index >= 0) bookmarks.splice(index, 1);
  else {
    bookmarks.unshift({ id: randomUUID(), url: tab.url, title: tab.title });
    bookmarks.length = Math.min(bookmarks.length, 1000);
  }
  saveSoon();
}

function adjustZoom(factor) {
  if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) throw new Error('Zoom must be between 25% and 500%.');
  activeTab()?.view?.webContents.setZoomFactor(factor);
}

async function runAction(name, p = {}) {
  if (closing) throw new Error('Relay is closing.');
  const wc = activeTab()?.view?.webContents;
  switch (name) {
    case 'newTab': addTab(p.input ? resolveAddress(p.input, profile.data.preferences.searchEngine) : ''); break;
    case 'selectTab': selectTab(requireTab(p.id)); break;
    case 'closeTab': closeTab(requireTab(p.id)); break;
    case 'pinTab': pinTab(requireTab(p.id)); break;
    case 'muteTab': {
      const target = requireTab(p.id).view?.webContents;
      if (target) target.setAudioMuted(!target.isAudioMuted());
      break;
    }
    case 'navigate': navigate(requireTab(), resolveAddress(p.input, profile.data.preferences.searchEngine)); break;
    case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': {
      const tab = requireTab();
      if (wc?.isLoading()) wc.stop();
      else if (tab.error && tab.url) navigate(tab, tab.url);
      else wc?.reload();
      break;
    }
    case 'home': goHome(requireTab()); break;
    case 'reopenTab': {
      const last = closedTabs[0];
      if (last) { addTab(last.url, { pinned: last.pinned }); closedTabs.shift(); }
      break;
    }
    case 'preferences': return updatePreferences(p);
    case 'bookmarkToggle': toggleBookmark(requireTab()); break;
    case 'removeBookmark':
      profile.data.bookmarks = profile.data.bookmarks.filter(({ id }) => id !== p.id);
      saveSoon();
      break;
    case 'clearHistory': profile.data.history = []; saveSoon(); break;
    case 'loadExtension': return extensions.loadUnpacked();
    case 'installExtension': return extensions.installFromStore(p.input);
    case 'removeExtension': {
      for (const tab of tabs.slice()) {
        if (extensionPage(tab.url) && new URL(tab.url).hostname === p.id) closeTab(tab, false);
      }
      return extensions.remove(p.id);
    }
    case 'openExtension': {
      const url = extensions.getPageUrl(p.id);
      if (!url) throw new Error('This extension does not expose a popup or options page.');
      addTab(url);
      break;
    }
    case 'downloadCancel': activeDownloads.get(p.id)?.cancel(); break;
    case 'downloadOpen':
    case 'downloadReveal': {
      const download = profile.data.downloads.find((item) => item.id === p.id && item.state === 'completed');
      if (!download?.file || !existsSync(download.file)) throw new Error('This downloaded file is no longer available.');
      if (name === 'downloadReveal') shell.showItemInFolder(download.file);
      else {
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', title: 'Open download', message: `Open ${download.name}?`,
          detail: download.file, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true
        });
        if (response === 1) {
          const error = await shell.openPath(download.file);
          if (error) throw new Error(error);
        }
      }
      break;
    }
    case 'agentEnable': await changeAgent(() => setAgent(p.enabled)); break;
    case 'agentRotate':
      await changeAgent(async () => {
        if (!agent.status().enabled) throw new Error('Enable the agent connection first.');
        await agent.stop();
        await agent.start();
      });
      break;
    case 'copy':
      if (typeof p.text !== 'string' || p.text.length > 32768) throw new Error('There is nothing to copy.');
      clipboard.writeText(p.text);
      break;
    case 'window':
      if (p.command === 'minimize') win.minimize();
      else if (p.command === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (p.command === 'close') win.close();
      else throw new Error('Unknown window command.');
      break;
    case 'fullScreen': win.setFullScreen(!win.isFullScreen()); break;
    case 'find':
      if (wc && typeof p.query === 'string' && p.query && p.query.length <= 1000) {
        activeTab().findRequestId = wc.findInPage(p.query, { findNext: p.findNext === true, forward: p.forward !== false });
      }
      break;
    case 'stopFind': wc?.stopFindInPage('clearSelection'); break;
    case 'zoom': adjustZoom(p.factor); break;
    default: throw new Error('Unknown browser action.');
  }
}

function attempt(work) {
  try { work(); } catch (error) { if (win && !win.isDestroyed()) dialog.showErrorBox('Relay Browser', error.message); }
}

function installShortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.meta) return;
    const key = input.key.toLowerCase();
    let work;
    if (key === 'f11' && !input.control && !input.alt) work = () => win.setFullScreen(!win.isFullScreen());
    if (key === 'escape' && win.isFullScreen()) work = () => win.setFullScreen(false);
    if (key === 'f5' && !input.alt && !input.control) work = () => wc === win.webContents ? activeTab()?.view?.webContents.reload() : wc.reload();
    if (input.alt && !input.control) {
      if (key === 'arrowleft') work = () => activeTab()?.view?.webContents.navigationHistory.goBack();
      if (key === 'arrowright') work = () => activeTab()?.view?.webContents.navigationHistory.goForward();
      if (key === 'home') work = () => { goHome(requireTab()); broadcast(); };
    }
    if (input.control && !input.alt) {
      const commands = input.shift ? { a: 'toggleAgent', o: 'showBookmarks' } : {
        l: 'focusAddress', h: 'showHistory', j: 'showDownloads', f: 'showFind',
        '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', 0: 'zoomReset'
      };
      if (Object.hasOwn(commands, key)) work = () => { win.webContents.focus(); send('relay:command', commands[key]); };
      if (key === 't') work = input.shift ? () => {
        const last = closedTabs[0];
        if (last) { addTab(last.url, { pinned: last.pinned }); closedTabs.shift(); }
      } : () => { addTab(); send('relay:command', 'focusAddress'); };
      if (!input.shift && key === 'w') work = () => closeTab(requireTab());
      if (!input.shift && key === 'd') work = () => { toggleBookmark(requireTab()); broadcast(); };
      if (!input.shift && key === 'p') work = () => activeTab()?.view?.webContents.print();
      if (!input.shift && key === 'r') work = () => activeTab()?.view?.webContents.reload();
      if (key === 'tab') work = () => {
        const index = tabs.indexOf(activeTab());
        selectTab(tabs[(index + (input.shift ? -1 : 1) + tabs.length) % tabs.length]);
      };
      if (!input.shift && /^[1-9]$/.test(key)) work = () => {
        const target = key === '9' ? tabs.at(-1) : tabs[Number(key) - 1];
        if (target) selectTab(target);
      };
    }
    if (!work) return;
    event.preventDefault();
    attempt(work);
  });
}

function trusted(event) {
  const frame = event.senderFrame;
  return win && !win.isDestroyed() && event.sender === win.webContents && frame && !frame.parent && frame.url === APP_URL;
}

ipcMain.handle('relay:get-state', (event) => {
  if (!trusted(event)) throw new Error('Untrusted browser window.');
  return getState();
});
ipcMain.handle('relay:action', async (event, name, payload) => {
  if (!trusted(event)) return { ok: false, error: 'Untrusted browser window.' };
  try {
    const value = await runAction(name, payload);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.message || 'Action failed.' };
  } finally {
    broadcast();
  }
});
ipcMain.on('relay:viewport', (event, bounds) => { if (trusted(event)) setViewport(bounds); });

async function launch() {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  profile = createProfile(userData);
  profile.data.downloads = profile.data.downloads.map((item) => item.state === 'progressing' ? { ...item, state: 'interrupted' } : item);
  discoveryPath = path.join(userData, 'agent-connection.json');
  agent = createAgentBridge({ getPreferences: () => ({ ...profile.data.preferences }), updatePreferences, onStatus: broadcast, discoveryPath });
  if (profile.data.agentEnabled) await agent.start().catch((error) => console.error('Starting agent connection:', error));
  else await agent.stop().catch((error) => console.error('Cleaning up agent connection:', error));
  const uiSession = session.fromPartition('relay-ui');
  uiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  uiSession.setPermissionCheckHandler(() => false);
  uiSession.protocol.handle('relay', (request) => {
    const url = new URL(request.url);
    const relative = url.pathname.slice(1);
    if (url.hostname !== 'shell' || request.method !== 'GET' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:html|js|css|png|webp|jpg|woff2|svg)$/.test(relative)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(RENDERER_DIR, relative)).href);
  });
  browserSession = session.fromPartition('persist:relay-browser');
  configurePermissions(browserSession);
  browserSession.on('will-download', (_event, item, wc) => trackDownload(item, wc));
  const originalUserAgent = browserSession.getUserAgent();
  browserSession.setUserAgent(originalUserAgent.replace(/\s(?:Electron|RelayBrowser|relay-browser)\/[^ ]+/gi, ''));
  win = new BrowserWindow({
    title: 'Relay Browser', width: 1280, height: 840, minWidth: 820, minHeight: 540,
    frame: false, show: false, backgroundColor: '#101816', icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { session: uiSession, contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs'), webviewTag: false }
  });
  extensions = createExtensionManager({
    browserSession, userData,
    selectDirectory: async () => {
      const result = await dialog.showOpenDialog(win, { title: 'Load unpacked Chrome extension', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    },
    confirmInstall: async ({ name, version, source, permissions, hostPermissions }) => {
      const detail = [`Version ${version} · ${source}`, `Permissions: ${permissions.join(', ') || 'none listed'}`, `Site access: ${hostPermissions.join(', ') || 'none listed'}`].join('\n');
      const result = await dialog.showMessageBox(win, {
        type: 'question', title: 'Add Chrome extension', message: `Add ${name} to Relay Browser?`,
        detail: detail.slice(0, 4500), buttons: ['Cancel', 'Add extension'], cancelId: 0, defaultId: 0, noLink: true
      });
      return result.response === 1;
    }
  });
  await extensions.restore().catch((error) => console.error('Restoring extensions:', error));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  installShortcuts(win.webContents);
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'resize']) {
    win.on(event, () => { updateView(); broadcast(); });
  }
  win.once('ready-to-show', () => win.show());
  win.on('close', () => {
    closing = true;
    clearTimeout(saveTimer);
    try { saveProfile(); } catch (error) { console.error('Closing Relay profile:', error); }
  });
  win.on('closed', () => {
    for (const tab of tabs) tab.view?.webContents.close();
    win = undefined;
  });
  let previousTab;
  for (const item of profile.data.lastSession) {
    if (!item || (item.url && !webURL(item.url))) continue;
    const tab = addTab(item.url || '', { activate: false, pinned: item.pinned === true, lazy: true });
    if (item.active) previousTab = tab;
  }
  if (tabs.length) selectTab(previousTab ?? tabs[0]);
  else addTab(profile.data.preferences.homepage);
  await win.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) { win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!agent || agentStopped) return;
    event.preventDefault();
    if (stoppingAgent) return;
    stoppingAgent = true;
    void changeAgent(() => agent.stop()).catch((error) => console.error('Stopping agent connection:', error)).finally(() => {
      agentStopped = true;
      app.quit();
    });
  });
  app.whenReady().then(launch).catch((error) => {
    console.error(error);
    dialog.showErrorBox('Relay Browser could not start', error.message);
    app.exit(1);
  });
}
