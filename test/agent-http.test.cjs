'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { request } = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createAgentBridge } = require('../src/agent/bridge.cjs');
const { DEFAULT_PREFERENCES } = require('../src/agent/preferences.cjs');

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-provider-test-'));
  const discoveryPath = join(directory, 'agent-connection.json');
  const preferences = { ...DEFAULT_PREFERENCES };
  const bridge = createAgentBridge({
    discoveryPath,
    getPreferences: () => preferences,
    updatePreferences: patch => Object.assign(preferences, patch)
  });
  context.after(async () => {
    await bridge.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { bridge, discoveryPath, preferences };
}

function send(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const client = request(url, { method, headers, agent: false }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        resolve({ code: response.statusCode, body: payload });
      } catch (error) {
        reject(error);
      }
    });
    client.on('error', reject);
    client.end(body);
  });
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function providerCall(grant, message, headers = {}) {
  return send(grant.url, 'POST', {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    ...bearer(grant.token),
    ...headers
  }, JSON.stringify({ jsonrpc: '2.0', ...message }));
}

test('provider credentials are isolated from manual access and independently revocable', async context => {
  const { bridge, discoveryPath } = await fixture(context);
  const [chatgpt, claude, sameChatgpt] = await Promise.all([
    bridge.grantProvider('chatgpt'), bridge.grantProvider('claude'), bridge.grantProvider('chatgpt')
  ]);
  assert.deepEqual(chatgpt, sameChatgpt);
  assert.notEqual(chatgpt.token, claude.token);
  assert.match(chatgpt.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(bridge.status().enabled, false);
  await assert.rejects(readFile(discoveryPath), { code: 'ENOENT' });

  const ping = { id: 1, method: 'ping' };
  assert.equal((await providerCall(chatgpt, ping, { Origin: 'https://example.org' })).code, 403);
  assert.equal((await providerCall(chatgpt, ping, { Host: 'example.org' })).code, 403);
  assert.equal((await providerCall(chatgpt, ping, { 'Sec-Fetch-Site': 'same-site' })).code, 403);
  assert.equal((await providerCall(chatgpt, ping, bearer('a'.repeat(43)))).code, 401);
  assert.equal((await providerCall(chatgpt, ping, { Accept: 'application/json' })).code, 406);
  assert.equal((await send(chatgpt.url, 'GET', bearer(chatgpt.token))).code, 405);
  assert.equal((await send(chatgpt.url, 'DELETE', bearer(chatgpt.token))).code, 405);
  assert.equal((await send(new URL('/v1/preferences', chatgpt.url), 'GET', bearer(chatgpt.token))).code, 404);

  const manual = await bridge.start();
  assert.equal((await providerCall(chatgpt, ping, bearer(manual.token))).code, 401);
  assert.equal((await send(manual.endpoint, 'GET', bearer(chatgpt.token))).code, 401);
  await bridge.stop();
  assert.equal((await providerCall(chatgpt, ping)).code, 200);
  await bridge.revokeProvider('chatgpt');
  assert.equal((await providerCall(chatgpt, ping)).code, 401);
  assert.equal((await providerCall(claude, ping)).code, 200);
  const newChatgpt = await bridge.grantProvider('chatgpt');
  assert.notEqual(newChatgpt.token, chatgpt.token);
  assert.equal((await providerCall(newChatgpt, ping)).code, 200);
  await bridge.shutdown();
  await assert.rejects(providerCall(claude, ping), { code: 'ECONNREFUSED' });
  await assert.rejects(bridge.grantProvider('claude'), /has stopped/);
});

test('provider HTTP carries legacy and modern MCP and validates modern mirrored headers', async context => {
  const { bridge, preferences } = await fixture(context);
  const grant = await bridge.grantProvider('claude');
  const initialize = await providerCall(grant, { id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1.0' }, capabilities: {}
  } });
  assert.equal(initialize.code, 200);
  assert.equal(initialize.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(await providerCall(grant, { method: 'notifications/initialized' }), { code: 202, body: null });

  const legacy = await providerCall(grant, { id: 2, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-06-18' });
  assert.equal(legacy.body.result.tools.length, 8);
  assert.equal(legacy.body.result.resultType, undefined);

  const version = '2026-07-28';
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {}
  };
  const headers = { 'MCP-Protocol-Version': version, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'set_browser_preferences' };
  const modern = { id: 3, method: 'tools/call', params: { _meta, name: 'set_browser_preferences', arguments: { tabPosition: 'right' } } };
  const mismatch = await providerCall(grant, modern, { ...headers, 'Mcp-Name': 'get_browser_preferences' });
  assert.equal(mismatch.code, 400);
  assert.equal(mismatch.body.error.code, -32020);
  assert.equal(preferences.tabPosition, 'top');

  const correct = await providerCall(grant, modern, headers);
  assert.equal(correct.code, 200);
  assert.equal(correct.body.result.resultType, 'complete');
  assert.equal(correct.body.result.structuredContent.tabPosition, 'right');
  assert.equal(preferences.tabPosition, 'right');
  const unsupported = await providerCall(grant, { id: 4, method: 'resources/list', params: { _meta } }, { ...headers, 'Mcp-Method': 'resources/list' });
  assert.equal(unsupported.code, 404);
  assert.equal(unsupported.body.error.code, -32601);
});
