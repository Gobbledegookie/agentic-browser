const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultCustomization, updateCustomization, keyboardAccelerator } = require('../src/customization.cjs');
const { createProfile } = require('../src/profile.cjs');

test('a customization patch preserves fields and validates command sequences', () => {
  const baseline = defaultCustomization();
  const edited = updateCustomization(baseline, {
    css: ':scope { color: teal; }',
    buttons: [{ id: 'work', label: 'Work', location: 'toolbar', steps: [{ command: 'newTab' }, { command: 'zoom', arguments: { factor: 1.2 } }] }],
    shortcuts: [{ id: 'work-key', accelerator: 'shift+CTRL+k', command: 'newTab' }]
  });
  assert.equal(edited.buttons[0].steps[0].command, 'newTab');
  assert.deepEqual(edited.buttons[0].steps[0].arguments, {});
  assert.equal(edited.shortcuts[0].accelerator, 'Ctrl+Shift+K');
  assert.equal(keyboardAccelerator({ control: true, shift: true, key: 'K' }), 'ctrl+shift+k');
  assert.deepEqual(updateCustomization(edited, { hiddenControls: ['home'] }), { ...edited, hiddenControls: ['home'] });
  assert.deepEqual(baseline.buttons, []);
});

test('custom contributions cannot attach privileged IPC actions or hide recovery controls', () => {
  const baseline = defaultCustomization();
  assert.throws(() => updateCustomization(baseline, { hiddenControls: ['agentButton'] }), /hideable/);
  assert.throws(() => updateCustomization(baseline, {
    buttons: [{ id: 'bad', label: 'Bad', location: 'menu', command: 'agentEnable', arguments: { enabled: true } }]
  }), /Unknown browser command/);
  assert.throws(() => updateCustomization(baseline, {
    shortcuts: [{ id: 'reserved', accelerator: 'F11', command: 'newTab' }]
  }), /Use a shortcut/);
});

test('expanded control requires new consent from existing users and keeps their existing settings', (t) => {
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-customization-'));
  t.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataPath, 'profile.json'), JSON.stringify({ agentEnabled: true, preferences: { tabPosition: 'right' } }));
  const upgraded = createProfile(dataPath);
  assert.equal(upgraded.data.agentEnabled, false);
  assert.equal(upgraded.data.preferences.tabPosition, 'right');
  upgraded.data.agentEnabled = true;
  upgraded.data.customization = updateCustomization(upgraded.data.customization, { newTabHtml: '<h1>My workspace</h1>' });
  upgraded.save();
  const restarted = createProfile(dataPath);
  assert.equal(restarted.data.agentEnabled, true);
  assert.equal(restarted.data.customization.newTabHtml, '<h1>My workspace</h1>');
});
