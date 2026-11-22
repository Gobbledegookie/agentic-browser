'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { listBrowserCommands, validateBrowserCommand } = require('../src/commands.cjs');

test('publishes an independent closed argument schema for every supported command', () => {
  const manifest = listBrowserCommands();
  assert.equal(manifest.length, new Set(manifest.map(({ name }) => name)).size);
  assert.ok(manifest.some(({ name }) => name === 'clearBrowsingData'));
  for (const { inputSchema } of manifest) {
    assert.equal(inputSchema.type, 'object');
    assert.equal(inputSchema.additionalProperties, false);
  }
  manifest.find(({ name }) => name === 'window').inputSchema.properties.command.enum.push('close');
  assert.throws(() => validateBrowserCommand('window', { command: 'close' }), TypeError);
});

test('rejects undisclosed commands and arguments that cross the browser boundary', () => {
  for (const [name, args] of [
    ['agentEnable', { enabled: true }],
    ['agentRotate', {}],
    ['copy', { text: 'secret' }],
    ['constructor', {}],
    ['downloadOpen', { id: 'download-id', path: 'C:\\any-file.exe' }],
    ['loadExtension', { directory: 'C:\\custom-extension' }],
    ['preferences', JSON.parse('{"__proto__":{"tabPosition":"left"}}')],
    ['preferences', { tabPosition: 'bottom' }],
    ['clearBrowsingData', {}],
    ['clearBrowsingData', { types: [] }],
    ['clearBrowsingData', { types: ['cookies', 'cookies'] }],
    ['clearBrowsingData', { types: ['credentials'] }],
    ['moveTab', { id: 'tab-id', index: 0.5 }],
    ['createWorkspace', { name: '   ' }],
    ['renameWorkspace', { workspaceId: 'work', name: 'a'.repeat(61) }],
    ['moveTabToWorkspace', { tabId: 'tab-id' }],
    ['setWindowBounds', { width: 300, x: 20 }],
    ['navigate', { input: '   ' }],
    ['navigate', { input: 'file:///C:/Windows' }],
    ['newTab', { input: 'javascript:alert(1)' }],
    ['updateBookmark', { url: 'https://user:pass@example.test/' }],
    ['updateBookmark', { id: 'bookmark-id' }],
    ['updateBookmark', { title: 'Title alone' }],
    ['revokeSitePermission', { origin: 'https://example.test/path', permission: 'media' }],
    ['revokeSitePermission', { origin: 'http://example.test', permission: 'media' }],
    ['readPage', { maxCharacters: 16001 }],
    ['readPage', { selector: 'input[type=password]' }]
  ]) {
    assert.throws(() => validateBrowserCommand(name, args), TypeError, name);
  }
});

test('normalizes supported changes using the browser’s URL and preference rules', () => {
  assert.deepEqual(validateBrowserCommand('newTab'), {});
  assert.deepEqual(validateBrowserCommand('navigate', { input: '  example.test  ' }), { input: 'example.test' });
  assert.deepEqual(validateBrowserCommand('moveTab', { id: 'tab-id', index: 2 }), { id: 'tab-id', index: 2 });
  assert.deepEqual(validateBrowserCommand('pinTab', { id: 'tab-id', pinned: false }), { id: 'tab-id', pinned: false });
  assert.deepEqual(validateBrowserCommand('fullScreen', { enabled: false }), { enabled: false });
  assert.deepEqual(validateBrowserCommand('openPanel', { panel: 'customization' }), { panel: 'customization' });
  assert.deepEqual(validateBrowserCommand('openPanel', { panel: null }), { panel: 'close' });
  assert.deepEqual(validateBrowserCommand('updateBookmark', { id: 'bookmark-id', title: 'Renamed' }), {
    id: 'bookmark-id', title: 'Renamed'
  });
  assert.deepEqual(validateBrowserCommand('readPage', { selectionOnly: true, maxCharacters: 600 }), {
    selectionOnly: true, maxCharacters: 600
  });
  assert.deepEqual(validateBrowserCommand('preferences', {
    homepage: 'https://EXAMPLE.test', tabPosition: 'right', bookmarksBar: true
  }), { homepage: 'https://example.test/', tabPosition: 'right', bookmarksBar: true });
  assert.deepEqual(validateBrowserCommand('revokeSitePermission', {
    origin: 'https://EXAMPLE.test:443/', permission: 'notifications'
  }), { origin: 'https://example.test', permission: 'notifications' });
});
