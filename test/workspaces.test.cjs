const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createProfile } = require('../src/profile.cjs');

function profileDirectory(t, data) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-workspaces-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (data) writeFileSync(join(directory, 'profile.json'), JSON.stringify(data));
  return directory;
}

test('an existing Relay profile migrates its tabs to the default workspace', (t) => {
  const lastSession = [
    { url: 'https://example.com/', pinned: true, active: false },
    { url: '', pinned: false, active: true }
  ];
  const history = [{ id: 'visit', url: 'https://example.com/', title: 'Example' }];
  const directory = profileDirectory(t, { lastSession, history });
  const profile = createProfile(directory);

  assert.deepEqual(profile.data.workspaces, [{ id: 'default', name: 'Default' }]);
  assert.equal(profile.data.activeWorkspaceId, 'default');
  assert.deepEqual(profile.data.lastSession, lastSession.map((tab) => ({ ...tab, workspaceId: 'default' })));
  assert.deepEqual(profile.data.history, history);
});

test('a selected empty workspace and the other workspaces’ tabs survive a profile reload', (t) => {
  const directory = profileDirectory(t);
  const profile = createProfile(directory);
  profile.data.workspaces.push({ id: 'reading', name: 'Reading' }, { id: 'work', name: 'Work' });
  profile.data.activeWorkspaceId = 'work';
  profile.data.lastSession.push({
    workspaceId: 'reading', url: 'https://example.com/', pinned: true, active: true
  });
  profile.save();

  const restored = createProfile(directory).data;
  assert.deepEqual(restored.workspaces, profile.data.workspaces);
  assert.equal(restored.activeWorkspaceId, 'work');
  assert.deepEqual(restored.lastSession, profile.data.lastSession);
  assert.equal(restored.lastSession.some(({ workspaceId }) => workspaceId === 'work'), false);
});

test('a legacy profile without tabs starts with its configured homepage', (t) => {
  const homepage = 'https://example.com/';
  const directory = profileDirectory(t, { preferences: { homepage }, lastSession: [] });

  assert.deepEqual(createProfile(directory).data.lastSession, [
    { workspaceId: 'default', url: homepage, pinned: false, active: true }
  ]);
});

test('invalid saved tab rows do not consume the restored tab limit', (t) => {
  const validTab = { url: 'https://example.com/', pinned: true, active: true };
  const directory = profileDirectory(t, {
    lastSession: [...Array.from({ length: 100 }, () => ({ url: 'invalid address' })), false, [], validTab]
  });

  assert.deepEqual(createProfile(directory).data.lastSession, [{ workspaceId: 'default', ...validTab }]);
});

test('a downgrade keeps workspace metadata recoverable without duplicating matched flat tabs', (t) => {
  const directory = profileDirectory(t);
  const profile = createProfile(directory);
  profile.data.workspaces.push({ id: 'work', name: 'Work' }, { id: 'reading', name: 'Reading' });
  profile.data.activeWorkspaceId = 'work';
  profile.data.lastSession = [
    { workspaceId: 'work', url: 'https://example.org/', pinned: true, active: true },
    { workspaceId: 'reading', url: 'https://example.org/', pinned: false, active: true },
    { workspaceId: 'reading', url: 'https://news.example/', pinned: false, active: false }
  ];
  profile.save();

  const oldBuild = {
    lastSession: [
      { url: 'https://EXAMPLE.org/', pinned: false, active: false },
      { url: 'https://work.example/', pinned: false, active: true }
    ],
    preferences: { theme: 'light' }
  };
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(oldBuild));
  const restored = createProfile(directory);
  assert.deepEqual(restored.data.workspaces, profile.data.workspaces);
  assert.equal(restored.data.activeWorkspaceId, 'work');
  assert.deepEqual(restored.data.lastSession, [
    profile.data.lastSession[0],
    { ...profile.data.lastSession[1], url: oldBuild.lastSession[0].url },
    profile.data.lastSession[2],
    { workspaceId: 'default', ...oldBuild.lastSession[1] }
  ]);
  assert.equal(restored.data.preferences.theme, 'light');
  restored.save();
  assert.deepEqual(createProfile(directory).data.lastSession, restored.data.lastSession);
});

test('an authoritative empty workspace layout ignores an older recovery snapshot', (t) => {
  const directory = profileDirectory(t);
  const profile = createProfile(directory);
  profile.data.workspaces.push({ id: 'previous', name: 'Previous' });
  profile.data.lastSession = [{ workspaceId: 'previous', url: 'https://example.org/', pinned: false, active: true }];
  profile.save();

  const current = {
    workspaces: [{ id: 'default', name: 'Default' }, { id: 'new', name: 'New' }],
    activeWorkspaceId: 'new',
    lastSession: []
  };
  writeFileSync(join(directory, 'profile.json'), JSON.stringify(current));
  const { workspaces, activeWorkspaceId, lastSession } = createProfile(directory).data;
  assert.deepEqual({ workspaces, activeWorkspaceId, lastSession }, current);
});
