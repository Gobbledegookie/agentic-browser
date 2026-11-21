'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { request } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { createAgentBridge } = require('../src/agent/bridge.cjs');
const { DEFAULT_PREFERENCES, validatePreferencesPatch } = require('../src/agent/preferences.cjs');

const DEFAULT_CUSTOMIZATION = { css: '', newTabHtml: '', buttons: [], hiddenControls: [], shortcuts: [] };
const COMMANDS = [{ name: 'newTab', description: 'Open a tab', inputSchema: { type: 'object', properties: { input: { type: 'string' } } } }];

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-agent-test-'));
  const discoveryPath = join(directory, 'agent-connection.json');
  const preferences = { ...DEFAULT_PREFERENCES, privateState: 'not-for-agents' };
  const statusChanges = [];
  const tabs = [];
  let customization = { ...DEFAULT_CUSTOMIZATION };
  const bridge = createAgentBridge({
    discoveryPath,
    getPreferences: () => preferences,
    updatePreferences: patch => Object.assign(preferences, patch),
    getBrowserState: () => ({ tabs }),
    listBrowserCommands: () => COMMANDS,
    runBrowserCommand: (name, args) => {
      if (name !== 'newTab') throw new TypeError('Unknown browser command.');
      if (typeof args.input !== 'string') throw new TypeError('input must be a string.');
      const tab = { id: String(tabs.length + 1), input: args.input };
      tabs.push(tab);
      return tab;
    },
    getCustomization: () => customization,
    updateCustomization: patch => {
      if (Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_CUSTOMIZATION, key))) throw new TypeError('Unknown customization field.');
      Object.assign(customization, patch);
    },
    resetCustomization: () => { customization = { ...DEFAULT_CUSTOMIZATION }; },
    onStatus: status => statusChanges.push(status.enabled)
  });
  context.after(async () => {
    await bridge.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, discoveryPath, preferences, statusChanges };
}

function callApi(endpoint, { method = 'GET', headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const client = request(endpoint, { method, headers, agent: false }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ code: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch (error) {
        reject(error);
      }
    });
    client.on('error', reject);
    client.end(body);
  });
}

test('the bridge is opt-in, local, authenticated and revocable', async context => {
  const { bridge, discoveryPath, statusChanges } = await fixture(context);
  assert.equal(bridge.status().enabled, false);
  await assert.rejects(readFile(discoveryPath), { code: 'ENOENT' });

  const [{ endpoint, token }, same] = await Promise.all([bridge.start(), bridge.start()]);
  assert.equal(same.token, token);
  assert.equal(new URL(endpoint).hostname, '127.0.0.1');
  assert.deepEqual(JSON.parse(await readFile(discoveryPath, 'utf8')), { endpoint, token });
  assert.equal((await callApi(endpoint)).code, 401);
  assert.equal((await callApi(endpoint, { headers: { Authorization: `Bearer ${'a'.repeat(43)}` } })).code, 401);

  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await callApi(endpoint, { headers: { ...headers, Origin: 'https://example.org' } })).code, 403);
  assert.equal((await callApi(endpoint, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).code, 403);
  assert.equal((await callApi(endpoint, { headers: { ...headers, Host: 'example.org' } })).code, 403);
  assert.deepEqual(await callApi(endpoint, { headers }), { code: 200, body: { preferences: DEFAULT_PREFERENCES } });

  await bridge.stop();
  assert.equal(bridge.status().enabled, false);
  await assert.rejects(readFile(discoveryPath), { code: 'ENOENT' });
  const restarted = await bridge.start();
  assert.notEqual(restarted.token, token);
  assert.equal((await callApi(restarted.endpoint, { headers })).code, 401);
  assert.deepEqual(statusChanges, [true, false, true]);
});

test('invalid bridge updates do not mutate preferences', async context => {
  const { bridge, preferences } = await fixture(context);
  const { endpoint, token } = await bridge.start();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const patch = body => callApi(endpoint, { method: 'PATCH', headers, body });

  assert.equal((await patch('{')).code, 400);
  assert.equal((await patch('{}')).code, 400);
  assert.equal((await patch('{"tabPosition":"left","extra":true}')).code, 400);
  assert.equal((await patch('{"__proto__":{"theme":"light"}}')).code, 400);
  assert.equal((await patch('{"theme":"chartreuse"}')).code, 400);
  assert.equal((await patch(' '.repeat(8193))).code, 413);
  assert.equal(preferences.tabPosition, 'top');
  assert.equal(preferences.theme, 'dark');
  assert.throws(() => validatePreferencesPatch({ homepage: 'https://user:pass@example.org' }), TypeError);
  assert.throws(() => validatePreferencesPatch({ homepage: 'file:///C:/Windows' }), TypeError);

  const result = await patch('{"tabPosition":"right","bookmarksBar":true,"homepage":"https://example.org"}');
  assert.deepEqual(result, { code: 200, body: { preferences: { ...DEFAULT_PREFERENCES, tabPosition: 'right', bookmarksBar: true, homepage: 'https://example.org/' } } });
  assert.equal(preferences.tabPosition, 'right');
});

test('browser state, commands and customization use the same authentication and bounded JSON API', async context => {
  const { bridge } = await fixture(context);
  const { endpoint, token } = await bridge.start();
  const browser = new URL('/v1/browser/', endpoint);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = (path, method = 'GET', body) => callApi(new URL(path, browser), { method, headers, body });
  assert.equal((await callApi(new URL('state', browser))).code, 401);
  assert.deepEqual(await call('state'), { code: 200, body: { state: { tabs: [] } } });
  assert.deepEqual(await call('commands'), { code: 200, body: { commands: COMMANDS } });
  assert.equal((await call('commands', 'PATCH', '{}')).code, 405);
  assert.equal((await call('commands', 'POST', '{"name":"a/b"}')).code, 400);
  assert.equal((await call('commands', 'POST', '{"name":"newTab","arguments":[]}')).code, 400);
  assert.equal((await call('commands', 'POST', '{"name":"unknown"}')).body.error, 'Unknown browser command.');
  const args = { input: 'https://example.org/' };
  const opened = await call('commands', 'POST', JSON.stringify({ name: 'newTab', arguments: args }));
  assert.deepEqual(opened, { code: 200, body: { result: { id: '1', ...args } } });
  assert.deepEqual((await call('state')).body.state.tabs, [opened.body.result]);

  assert.equal((await call('customization', 'PATCH', '{}')).code, 400);
  assert.equal((await call('customization', 'PATCH', '{"arbitraryField":true}')).code, 400);
  assert.equal((await call('customization', 'PATCH', JSON.stringify({ css: 'a'.repeat(256 * 1024) }))).code, 413);
  assert.equal((await call('commands', 'POST', JSON.stringify({ name: 'newTab', arguments: { input: 'a'.repeat(256 * 1024) } }))).code, 413);
  const patch = { css: `/* ${'a'.repeat(20000)} */`, newTabHtml: '<h1>My new tab</h1>' };
  const customized = await call('customization', 'PATCH', JSON.stringify(patch));
  assert.deepEqual(customized, { code: 200, body: { customization: { ...DEFAULT_CUSTOMIZATION, ...patch } } });
  assert.deepEqual(await call('customization'), customized);
  assert.deepEqual(await call('customization', 'DELETE'), { code: 200, body: { customization: DEFAULT_CUSTOMIZATION } });
});

function launchClient(context, discoveryPath) {
  const server = spawn(process.execPath, [join(__dirname, '../src/agent/mcp.cjs')], {
    env: { ...process.env, RELAY_AGENT_FILE: discoveryPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const done = once(server, 'exit');
  const responses = createInterface({ input: server.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let id = 0;
  let stderr = '';
  server.stderr.on('data', data => { stderr += data; });

  context.after(async () => {
    server.stdin.end();
    const [code] = await done;
    assert.equal(code, 0, stderr);
  });

  function notify(method) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async function call(method, params) {
    id += 1;
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await responses.next();
    assert.equal(next.done, false, stderr);
    const response = JSON.parse(next.value);
    assert.equal(response.id, id);
    return response;
  }

  return { call, notify };
}

test('a handshake-based MCP client can customize the running browser', { timeout: 10000 }, async context => {
  const { bridge, discoveryPath, preferences } = await fixture(context);
  const client = launchClient(context, discoveryPath);
  const handshake = await client.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
  assert.equal(handshake.result.protocolVersion, '2025-11-25');
  client.notify('notifications/initialized');
  const listing = await client.call('tools/list');
  assert.deepEqual(listing.result.tools.map(tool => tool.name), [
    'get_browser_preferences', 'set_browser_preferences', 'get_browser_state', 'list_browser_commands',
    'run_browser_command', 'get_browser_customization', 'update_browser_customization', 'reset_browser_customization'
  ]);

  const unavailable = await client.call('tools/call', { name: 'get_browser_preferences' });
  assert.equal(unavailable.result.isError, true);
  await bridge.start();
  const changed = await client.call('tools/call', { name: 'set_browser_preferences', arguments: { tabPosition: 'left', theme: 'light' } });
  assert.equal(changed.result.structuredContent.tabPosition, 'left');
  assert.equal(preferences.tabPosition, 'left');
  assert.equal(preferences.theme, 'light');
});

test('a stateless MCP client can discover and call the same tools', { timeout: 10000 }, async context => {
  const { bridge, discoveryPath } = await fixture(context);
  await bridge.start();
  const client = launchClient(context, discoveryPath);
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}
  };
  const discovery = await client.call('server/discover', { _meta });
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.equal(discovery.result._meta['io.modelcontextprotocol/serverInfo'].name, 'relay-browser');
  const listing = await client.call('tools/list', { _meta });
  assert.equal(listing.result.tools.length, 8);
  assert.equal(listing.result.cacheScope, 'public');
  assert.equal(typeof listing.result.ttlMs, 'number');
  const changed = await client.call('tools/call', { _meta, name: 'set_browser_preferences', arguments: { searchEngine: 'bing' } });
  assert.equal(changed.result.resultType, 'complete');
  assert.equal(changed.result.structuredContent.searchEngine, 'bing');
  await bridge.stop();
  const disabled = await client.call('tools/call', { _meta, name: 'get_browser_preferences' });
  assert.equal(disabled.result.isError, true);
});

test('an MCP client discovers browser commands and persists and resets a UI recipe', { timeout: 10000 }, async context => {
  const { bridge, discoveryPath } = await fixture(context);
  await bridge.start();
  const client = launchClient(context, discoveryPath);
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}
  };
  const call = (name, args) => client.call('tools/call', { _meta, name, arguments: args }).then(message => message.result);
  assert.deepEqual((await call('list_browser_commands')).structuredContent, { commands: COMMANDS });
  const args = { input: 'https://www.wikipedia.org/' };
  const opened = await call('run_browser_command', { name: 'newTab', arguments: args });
  assert.deepEqual(opened.structuredContent, { result: { id: '1', ...args } });
  assert.deepEqual((await call('get_browser_state')).structuredContent, { state: { tabs: [opened.structuredContent.result] } });
  const invalid = await call('run_browser_command', { name: 'unknown' });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0].text, 'Unknown browser command.');

  const recipes = {
    css: `/* ${'A'.repeat(20000)} */`,
    shortcuts: [{ id: 'wiki', accelerator: 'Ctrl+Shift+K', command: 'newTab', arguments: args }],
    buttons: [{ id: 'wiki', label: 'Wikipedia', location: 'toolbar', steps: [{ command: 'newTab', arguments: args }] }]
  };
  const updated = await call('update_browser_customization', recipes);
  assert.deepEqual(updated.structuredContent, { customization: { ...DEFAULT_CUSTOMIZATION, ...recipes } });
  assert.deepEqual((await call('get_browser_customization')).structuredContent, updated.structuredContent);
  assert.deepEqual((await call('reset_browser_customization')).structuredContent, { customization: DEFAULT_CUSTOMIZATION });
});
