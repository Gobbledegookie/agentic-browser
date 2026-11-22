const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_PREFERENCES, validatePreferencesPatch } = require('./agent/preferences.cjs');
const { defaultCustomization, updateCustomization } = require('./customization.cjs');
const { webURL, resolveAddress, SEARCH_PROVIDERS } = require('./address.cjs');

const MAX_HISTORY = 500;
const MAX_TABS = 100;
const MAX_WORKSPACE_NAME = 60;
const AGENT_ACCESS_VERSION = 2;

function records(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.id === 'string' && webURL(item.url) && typeof item.title === 'string').slice(0, limit);
}

function workspaceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > MAX_WORKSPACE_NAME) {
    throw new TypeError(`Enter a workspace name between 1 and ${MAX_WORKSPACE_NAME} characters.`);
  }
  return name;
}

function readData(file, label) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not load Relay ' + label + ':', error.message);
    return null;
  }
}

function workspaceEntries(entries) {
  const workspaces = [];
  const ids = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry?.id;
    if (typeof id !== 'string' || !id || id.length > 128 || ids.has(id)) continue;
    try {
      workspaces.push({ id, name: workspaceName(entry.name) });
      ids.add(id);
    } catch {}
  }
  return workspaces;
}

function sessionTabs(entries, ids, defaultId) {
  const tabs = [];
  for (const tab of Array.isArray(entries) ? entries : []) {
    if (tabs.length === MAX_TABS) break;
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) continue;
    const url = tab.url ?? '';
    if (url !== '' && !webURL(url)) continue;
    tabs.push({
      workspaceId: ids.has(tab.workspaceId) ? tab.workspaceId : defaultId,
      url,
      pinned: tab.pinned === true,
      active: tab.active === true
    });
  }
  return tabs;
}

function recoverSession(snapshot, current) {
  const urlKey = ({ url }) => url ? webURL(url).href : '';
  const remaining = current.map(tab => ({ tab, key: urlKey(tab) }));
  const matches = new Map();

  for (const matchPinned of [true, false]) {
    for (const old of snapshot) {
      if (matches.has(old)) continue;
      const key = urlKey(old);
      const index = remaining.findIndex(entry => entry.key === key && (!matchPinned || entry.tab.pinned === old.pinned));
      if (index >= 0) matches.set(old, remaining.splice(index, 1)[0].tab);
    }
  }

  // Reserve space for every current tab before restoring any snapshot-only tabs.
  let spare = MAX_TABS - current.length;
  const restored = [];
  for (const old of snapshot) {
    const currentTab = matches.get(old);
    if (currentTab) restored.push({ ...old, url: currentTab.url, pinned: currentTab.pinned });
    else if (spare > 0) {
      restored.push(old);
      spare -= 1;
    }
  }
  return restored.concat(remaining.map(({ tab }) => tab));
}

function restoreWorkspaces(saved, homepage, layoutFile) {
  let layout = saved;
  let workspaces = workspaceEntries(saved?.workspaces);
  if (saved && !workspaces.length) {
    const snapshot = readData(layoutFile, 'workspace snapshot');
    const recovered = snapshot?.version === 1 ? workspaceEntries(snapshot.workspaces) : [];
    if (recovered.length) {
      layout = snapshot;
      workspaces = recovered;
    }
  }

  const hasWorkspaces = workspaces.length > 0;
  if (!hasWorkspaces) workspaces.push({ id: 'default', name: 'Default' });
  const ids = new Set(workspaces.map(({ id }) => id));
  const defaultId = ids.has('default') ? 'default' : workspaces[0].id;
  const activeWorkspaceId = ids.has(layout?.activeWorkspaceId) ? layout.activeWorkspaceId : defaultId;
  const currentTabs = sessionTabs(saved?.lastSession, ids, defaultId);
  const lastSession = layout === saved ? currentTabs : recoverSession(sessionTabs(layout.lastSession, ids, defaultId), currentTabs);
  if (!hasWorkspaces && !lastSession.length) {
    lastSession.push({ workspaceId: defaultId, url: homepage, pinned: false, active: true });
  }
  return { workspaces, activeWorkspaceId, lastSession };
}

function writeAtomic(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function createProfile(dataPath) {
  const file = path.join(dataPath, 'profile.json');
  const layoutFile = path.join(dataPath, 'workspace-layout.json');
  const stored = readData(file, 'preferences');
  const saved = stored ?? {};

  const preferences = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(preferences)) {
    if (!Object.hasOwn(saved.preferences ?? {}, key)) continue;
    try {
      Object.assign(preferences, validatePreferencesPatch({ [key]: saved.preferences[key] }));
    } catch {}
  }
  let customization = defaultCustomization();
  if (saved.customization) {
    for (const key of Object.keys(customization)) {
      if (!Object.hasOwn(saved.customization, key)) continue;
      try { customization = updateCustomization(customization, { [key]: saved.customization[key] }); } catch {}
    }
  }
  const data = {
    preferences,
    searchProviderChosen: saved.searchProviderChosen === true && SEARCH_PROVIDERS.some(({ id }) => id === saved.preferences?.searchEngine),
    customization,
    agentAccessVersion: AGENT_ACCESS_VERSION,
    agentEnabled: saved.agentEnabled === true && saved.agentAccessVersion === AGENT_ACCESS_VERSION,
    approvedProviders: Array.isArray(saved.approvedProviders) ? [...new Set(saved.approvedProviders.filter((id) => id === 'chatgpt' || id === 'claude'))] : [],
    bookmarks: records(saved.bookmarks, 1000),
    history: records(saved.history, MAX_HISTORY),
    downloads: Array.isArray(saved.downloads) ? saved.downloads.filter((item) => item && typeof item.id === 'string').slice(0, 100) : [],
    ...restoreWorkspaces(stored, preferences.homepage, layoutFile)
  };

  function save() {
    fs.mkdirSync(dataPath, { recursive: true });
    writeAtomic(file, data);
    const { workspaces, activeWorkspaceId, lastSession } = data;
    try {
      writeAtomic(layoutFile, { version: 1, workspaces, activeWorkspaceId, lastSession });
    } catch (error) {
      console.warn('Could not save Relay workspace snapshot:', error.message);
    }
  }

  return { data, save };
}

module.exports = { createProfile, webURL, resolveAddress, workspaceName, MAX_HISTORY, MAX_TABS };
