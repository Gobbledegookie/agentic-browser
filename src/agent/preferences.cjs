'use strict';

const preferenceSchema = {
  tabPosition: { type: 'string', enum: ['top', 'left', 'right'], description: 'Place tabs above the page or in a left or right sidebar.' },
  theme: { type: 'string', enum: ['dark', 'light', 'system'], description: 'Set the browser chrome theme or follow Windows.' },
  homepage: { type: 'string', maxLength: 2048, description: 'Set a full HTTP or HTTPS URL, or use an empty string for Relay’s new tab page.' },
  searchEngine: { type: 'string', enum: ['duckduckgo', 'google', 'bing'], description: 'Choose the address bar search provider.' },
  bookmarksBar: { type: 'boolean', description: 'Show or hide the bookmarks toolbar.' }
};

const DEFAULT_PREFERENCES = Object.freeze({
  tabPosition: 'top',
  theme: 'dark',
  homepage: '',
  searchEngine: 'duckduckgo',
  bookmarksBar: false
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateHomepage(value) {
  if (value === '') return value;

  const url = URL.parse(value);
  if (!/^https?:\/\//i.test(value) || !url || url.username || url.password || /[\s\x00-\x1f\x7f\\]/.test(value)) {
    throw new TypeError('homepage must be an HTTP or HTTPS URL without credentials.');
  }
  if (url.href.length > preferenceSchema.homepage.maxLength) {
    throw new TypeError('homepage must be at most 2048 characters.');
  }
  return url.href;
}

function validatePreferencesPatch(patch) {
  if (!isObject(patch)) throw new TypeError('Preferences must be a JSON object.');

  const updates = {};
  for (const [name, value] of Object.entries(patch)) {
    if (!Object.hasOwn(preferenceSchema, name)) throw new TypeError('Unknown preference.');
    const rule = preferenceSchema[name];
    if (typeof value !== rule.type || (rule.enum && !rule.enum.includes(value))) {
      throw new TypeError(`Invalid value for ${name}.`);
    }
    if (rule.maxLength && value.length > rule.maxLength) {
      throw new TypeError(`${name} must be at most ${rule.maxLength} characters.`);
    }
    updates[name] = name === 'homepage' ? validateHomepage(value) : value;
  }
  return updates;
}

function publicPreferences(preferences) {
  return Object.fromEntries(Object.keys(preferenceSchema).map(name => [name, preferences[name]]));
}

module.exports = { DEFAULT_PREFERENCES, isObject, preferenceSchema, publicPreferences, validatePreferencesPatch };
