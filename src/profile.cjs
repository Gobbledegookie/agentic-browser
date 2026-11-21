const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DEFAULT_PREFERENCES, validatePreferencesPatch } = require('./agent/preferences.cjs');

const MAX_HISTORY = 500;
const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q='
};

function webURL(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const parsed = new URL(value);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed;
  } catch {}
  return null;
}

function resolveAddress(value, engine) {
  if (typeof value !== 'string') throw new Error('Enter an address or search term.');
  const input = value.trim();
  if (!input || input.length > 8192) throw new Error('Enter an address or search term up to 8192 characters.');
  if (/^https?:/i.test(input)) {
    const url = webURL(input);
    if (!url) throw new Error('Enter a valid HTTP or HTTPS address without credentials.');
    return url.href;
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) || /^(?:file|javascript|data|chrome|relay|about|blob|mailto):/i.test(input)) {
    throw new Error('Relay opens HTTP and HTTPS addresses.');
  }
  const host = input.split(/[/?#]/)[0];
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);
  if (loopback || (!/\s/.test(input) && /^[^@\\/:]+\.[^@\\/:]+(?::\d+)?$/.test(host))) {
    const url = webURL(`${loopback ? 'http' : 'https'}://${input}`);
    if (url) return url.href;
  }
  return `${SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo}${new URLSearchParams({ q: input }).toString().slice(2)}`;
}

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
  const data = {
    preferences,
    agentEnabled: saved.agentEnabled === true,
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
