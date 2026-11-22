const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_PREFERENCES, validatePreferencesPatch } = require('./agent/preferences.cjs');
const { defaultCustomization, updateCustomization } = require('./customization.cjs');
const { webURL, resolveAddress, SEARCH_PROVIDERS } = require('./address.cjs');

const MAX_HISTORY = 500;
const AGENT_ACCESS_VERSION = 2;

function records(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.id === 'string' && webURL(item.url) && typeof item.title === 'string').slice(0, limit);
}

function createProfile(dataPath) {
  const file = path.join(dataPath, 'profile.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not load Relay preferences:', error.message);
  }

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
    lastSession: Array.isArray(saved.lastSession) ? saved.lastSession.slice(0, 100) : []
  };

  function save() {
    fs.mkdirSync(dataPath, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  return { data, save };
}

module.exports = { createProfile, webURL, resolveAddress, MAX_HISTORY };
