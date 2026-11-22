'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LASTPASS_ID, createLastPassApi } = require('../src/lastpass-api.cjs');

const extensionOrigin = 'chrome-extension://' + LASTPASS_ID + '/';

function setup() {
  const calls = [];
  const events = [];
  const mainWindow = { id: 4, type: 'normal', focused: true, state: 'normal' };
  const tabs = [
    { id: 11, windowId: 4, active: true, url: 'https://fixture.test/form', title: 'Example form', privateField: true },
    { id: 12, windowId: 4, active: false, url: 'https://another.test/', title: 'Other page' },
  ];
  const extension = {
    id: LASTPASS_ID, name: 'LastPass',
    manifest: {
      permissions: ['tabs', 'cookies', 'contextMenus'],
      host_permissions: ['https://*.lastpass.com/*', 'https://*.lastpass.eu/*', 'https://fixture.test/*'],
      optional_permissions: ['privacy'],
      action: { default_title: 'LastPass', default_popup: 'toolbar.html', default_icon: { 32: 'icon.png' } },
    },
  };
  const record = (method, result) => (...args) => { calls.push([method, ...args]); return result; };
  const api = createLastPassApi({
    browserSession: { cookies: { get: record('cookies.get', [
      { name: 'fixture', value: 'synthetic', path: '/' },
      { name: 'fixture', value: 'synthetic-longest-path', path: '/account', arbitraryField: 'ignored' },
    ]) } },
    getExtension: id => id === extension.id ? extension : null,
    controller: {
      getTabs: () => tabs,
      getActiveTab: () => tabs[0],
      getWindow: () => mainWindow,
      createTab: record('createTab', tabs[1]),
      updateTab: record('updateTab', tabs[0]),
      removeTab: record('removeTab'),
      createWindow: record('createWindow', { ...mainWindow, id: 5 }),
      updateWindow: record('updateWindow', mainWindow),
      removeWindow: record('removeWindow'),
      actionChanged: record('actionChanged'),
    },
    emit: (...args) => events.push(args),
  });
  return { api, extension, tabs, calls, events };
}

test('LastPass cookie compatibility enforces URL, cookie name, declared permission, and profile scope', async () => {
  const { api, extension, calls } = setup();
  for (const url of [
    'http://accounts.lastpass.com/',
    'https://accounts.lastpass.com.evil.test/',
    'https://fixture.test/',
    'https://other.test/',
    'https://lastpass.com:8443/',
    'https://example:password@lastpass.com/',
  ]) {
    await assert.rejects(api.invoke('cookies.get', [{ url, name: 'fixture' }]), /granted HTTPS LastPass hosts/);
  }
  const request = { url: 'https://lastpass.eu/account', name: 'fixture', storeId: '0' };
  await assert.rejects(api.invoke('cookies.get', [{ ...request, storeId: '9' }]), /Invalid LastPass cookie request/);
  await assert.rejects(api.invoke('cookies.get', [{ ...request, name: '' }]), /Invalid LastPass cookie request/);
  await assert.rejects(api.invoke('cookies.getAll', [{}]), /not available/);
  await assert.rejects(api.invoke('cookies.set', [request]), /not available/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await api.invoke('cookies.get', [request]), {
    name: 'fixture', value: 'synthetic-longest-path', path: '/account', storeId: '0',
  });
  assert.deepEqual(calls, [['cookies.get', { url: 'https://lastpass.eu/account', name: 'fixture' }]]);
  extension.manifest.host_permissions = ['https://*.lastpass.com/*'];
  await assert.rejects(api.invoke('cookies.get', [request]), /granted HTTPS LastPass hosts/);
  extension.manifest.permissions = [];
  await assert.rejects(api.invoke('cookies.get', [{ ...request, url: 'https://lastpass.com/account' }]), /not granted/);
});

test('tab and window operations use real IDs, enforce URL boundaries, and resolve signed relative URLs', async () => {
  const { api, extension, calls } = setup();
  const active = await api.invoke('tabs.query', [{ active: true, currentWindow: true }]);
  assert.equal(active[0].id, 11);
  assert.equal(active[0].url, 'https://fixture.test/form');
  assert.equal(active[0].privateField, undefined);
  assert.equal(await api.invoke('tabs.getCurrent', []), undefined);
  assert.equal((await api.invoke('windows.getCurrent', [{ populate: true }])).tabs.length, 2);
  assert.equal((await api.invoke('windows.get', [-2])).id, 4);
  await api.invoke('tabs.update', [11, { url: 'folder/extension.html', active: true }]);
  await api.invoke('windows.create', [{ url: 'confirm.html', type: 'popup', width: 400, height: 580 }]);
  await assert.rejects(api.invoke('tabs.create', [{ url: 'https://elsewhere.test/' }]), /Invalid extension resource URL/);
  await assert.rejects(api.invoke('tabs.create', [{ url: 'file:///C:/Windows/test' }]), /Invalid extension resource URL/);
  await assert.rejects(api.invoke('tabs.create', [{ url: 'chrome-extension://other/popup.html' }]), /Invalid extension resource URL/);
  await assert.rejects(api.invoke('tabs.remove', []), /Invalid browser ID/);
  await assert.rejects(api.invoke('windows.create', [{ incognito: true }]), /cannot open an incognito/);
  assert.deepEqual(calls, [
    ['updateTab', 11, { url: extensionOrigin + 'folder/extension.html', active: true }],
    ['createWindow', { url: extensionOrigin + 'confirm.html', width: 400, height: 580, type: 'popup' }],
  ]);
  extension.manifest.permissions = ['cookies'];
  const other = await api.invoke('tabs.get', [12]);
  assert.equal(other.id, 12);
  assert.equal(other.url, undefined);
  assert.equal(other.title, undefined);
});

test('optional permissions are not silently granted and action state is scoped to a valid tab', async () => {
  const { api, extension } = setup();
  assert.equal(await api.invoke('permissions.contains', [{ permissions: ['cookies'], origins: ['https://accounts.lastpass.com/*'] }]), true);
  assert.equal(await api.invoke('permissions.request', [{ permissions: ['privacy'] }]), false);
  assert.equal((await api.invoke('permissions.getAll', [])).permissions.includes('privacy'), false);
  assert.equal(api.getAction(11).popup, extensionOrigin + 'toolbar.html');
  await api.invoke('browserAction.setIcon', [{ tabId: 11, path: { 19: 'small.png', 32: 'selected.png' } }]);
  await api.invoke('action.setBadgeText', [{ tabId: 11, text: '1' }]);
  assert.equal(api.getAction(11).icon, extensionOrigin + 'selected.png');
  assert.equal(api.getAction(12).icon, extensionOrigin + 'icon.png');
  assert.equal(await api.invoke('action.getBadgeText', [{ tabId: 11 }]), '1');
  await assert.rejects(api.invoke('action.setPopup', [{ popup: 'https://fixture.test/popup' }]), /Invalid extension resource URL/);
  await assert.rejects(api.invoke('action.setTitle.extra', [{ title: 'ignored' }]), /Invalid LastPass API request/);
  api.clearTab(11);
  assert.equal(api.getAction(11).badgeText, '');
  extension.id = 'not-installed';
  assert.equal(api.getAction(11), null);
  await assert.rejects(api.invoke('tabs.query', [{}]), /Invalid LastPass API request/);
});

test('LastPass context menus respect tabs and filters and dispatch their actual click', async () => {
  const { api, tabs, events } = setup();
  await api.invoke('contextMenus.create', [{ id: 'group', title: 'Group', contexts: ['all'] }]);
  await api.invoke('contextMenus.create', [{
    id: 'child', parentId: 'group', title: 'Use %s', contexts: ['selection'],
    documentUrlPatterns: ['https://fixture.test/f*'], type: 'checkbox', checked: false,
  }]);
  const noSitePermission = [];
  api.appendContextMenu(noSitePermission, { selectionText: 'fixture selection' }, tabs[1]);
  assert.deepEqual(noSitePermission, []);
  const menu = [];
  api.appendContextMenu(menu, { selectionText: 'fixture selection' }, tabs[0]);
  const item = menu[1].submenu[0].submenu[0];
  assert.equal(item.label, 'Use fixture selection');
  item.click({ checked: true });
  assert.equal(events[0][0], 'contextMenus.onClicked');
  assert.equal(events[0][1][0].menuItemId, 'child');
  assert.equal(events[0][1][0].checked, true);
  assert.equal(events[0][1][1].id, tabs[0].id);
  await api.invoke('contextMenus.remove', ['group']);
  const removed = [];
  api.appendContextMenu(removed, { selectionText: 'fixture selection' }, tabs[0]);
  assert.deepEqual(removed, []);
});
