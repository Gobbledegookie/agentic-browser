const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProfile } = require('../src/profile.cjs');

test('search setup remains unchosen until a valid explicit provider choice is saved', (t) => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-search-profile-'));
  t.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  const file = path.join(dataPath, 'profile.json');
  assert.equal(createProfile(dataPath).data.searchProviderChosen, false);
  fs.writeFileSync(file, JSON.stringify({ preferences: { searchEngine: 'bing' } }));
  const profile = createProfile(dataPath);
  assert.equal(profile.data.searchProviderChosen, false);
  assert.equal(profile.data.preferences.searchEngine, 'bing');

  profile.data.searchProviderChosen = true;
  profile.save();
  assert.equal(createProfile(dataPath).data.searchProviderChosen, true);
  assert.equal(createProfile(dataPath).data.preferences.searchEngine, 'bing');

  fs.writeFileSync(file, JSON.stringify({ searchProviderChosen: true, preferences: { searchEngine: 'unsupported' } }));
  assert.equal(createProfile(dataPath).data.searchProviderChosen, false);
});
