const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createExtensionManager, storeId, storeListingId, verifyStorePackage } = require('../src/extensions.cjs');

const storeExample = 'caacnjeoikecoeepknkbjdcaediamaej';

test('accepts exact current and legacy Chrome Web Store listing paths', () => {
  for (const url of [
    'https://chromewebstore.google.com/detail/json-formatter-classic/' + storeExample + '?hl=en',
    'https://chromewebstore.google.com/detail/' + storeExample + '#details',
    'https://chromewebstore.google.com/detail/%C3%A9diteur-JSON/' + storeExample,
    'https://chrome.google.com/webstore/detail/' + storeExample + '/',
    'https://chrome.google.com/webstore/detail/json-formatter-classic/' + storeExample,
  ]) {
    assert.equal(storeListingId(url), storeExample);
    assert.equal(storeId(url), storeExample);
  }
  assert.equal(storeListingId(storeExample), null);
  assert.equal(storeId(' ' + storeExample + ' '), storeExample);
});

test('rejects Store lookalikes and nonlisting paths', () => {
  for (const url of [
    'http://chromewebstore.google.com/detail/' + storeExample,
    'blob:https://chromewebstore.google.com/detail/' + storeExample,
    'https://chromewebstore.google.com.example.com/detail/' + storeExample,
    'https://person@chromewebstore.google.com/detail/' + storeExample,
    'https://@chromewebstore.google.com/detail/' + storeExample,
    'https://chromewebstore.google.com:8443/detail/' + storeExample,
    'https://chromewebstore.google.com/search/' + storeExample,
    'https://chromewebstore.google.com/detail//' + storeExample,
    'https://chromewebstore.google.com/detail/other/folders/' + storeExample,
    'https://chromewebstore.google.com/detail/slug/' + storeExample + '/reviews',
    'https://chromewebstore.google.com/detail/slug%2Fother/' + storeExample,
    'https://chromewebstore.google.com/user/../detail/' + storeExample,
    'https://chromewebstore.google.com/detail/%2E/' + storeExample,
    'https://chromewebstore.google.com/detail?extension_id=' + storeExample,
  ]) {
    assert.equal(storeListingId(url), null, url);
    assert.throws(() => storeId(url), /Chrome Web Store listing URL/);
  }
});

function varint(value) {
  const bytes = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function field(id, bytes) {
  return Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
}

test('requires a store publisher signature even with a valid developer proof', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
  const idBytes = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const id = idBytes.toString('hex').replace(/[0-9a-f]/g, hex => 'abcdefghijklmnop'[Number.parseInt(hex, 16)]);
  const archive = Buffer.from('example archive bytes');
  const signedHeader = field(1, idBytes);
  const signedHeaderSize = Buffer.alloc(4);
  signedHeaderSize.writeUInt32LE(signedHeader.length);
  const signature = sign('sha256', Buffer.concat([
    Buffer.from('CRX3 SignedData\0'), signedHeaderSize, signedHeader, archive,
  ]), keys.privateKey);
  const proof = field(3, Buffer.concat([field(1, publicKey), field(2, signature)]));
  const header = Buffer.concat([proof, field(10000, signedHeader)]);
  const magic = Buffer.from('Cr24\x03\x00\x00\x00\x00\x00\x00\x00');
  magic.writeUInt32LE(header.length, 8);
  const crx = Buffer.concat([magic, header, archive]);
  assert.throws(() => verifyStorePackage(crx, id), /publisher signature was missing/);
  assert.throws(() => verifyStorePackage(crx, storeExample), /did not match the requested extension/);
  crx[crx.length - 1] ^= 1;
  assert.throws(() => verifyStorePackage(crx, id), /signature did not verify/);
});

function fakeSession(id) {
  const loaded = new Map();
  return {
    extensions: {
      async loadExtension(directory, options) {
        assert.equal(options.allowFileAccess, false);
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        const extension = { id, manifest, name: manifest.name, version: manifest.version };
        loaded.set(id, extension);
        return extension;
      },
      getExtension: extensionId => loaded.get(extensionId),
      removeExtension: extensionId => loaded.delete(extensionId),
    },
  };
}

test('persists an approved unpacked extension and removes it without deleting its source', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-extension-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const directory = path.join(folder, 'source');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0',
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['https://example.test/*'] }],
    permissions: ['storage'],
  }));
  let approved = false;
  const options = {
    userData: path.join(folder, 'profile'),
    selectDirectory: async () => directory,
    confirmInstall: async details => {
      assert.deepEqual(details, {
        name: 'Fixture', version: '1.0', source: 'unpacked', permissions: ['storage'],
        hostPermissions: ['https://example.test/*'],
      });
      return approved;
    },
  };
  const manager = createExtensionManager({ ...options, browserSession: fakeSession(storeExample) });
  assert.equal(await manager.loadUnpacked(), false);
  assert.deepEqual(manager.list(), []);
  approved = true;
  assert.equal(await manager.loadUnpacked(), true);
  await assert.rejects(manager.loadUnpacked(), /already registered/);

  const restarted = createExtensionManager({ ...options, browserSession: fakeSession(storeExample) });
  await restarted.restore();
  assert.equal(restarted.list()[0].enabled, true);
  assert.equal(restarted.getPageUrl(storeExample), 'chrome-extension://' + storeExample + '/popup.html');
  assert.equal(await restarted.prepareOpen(storeExample), restarted.getPageUrl(storeExample));
  assert.equal(await restarted.remove(storeExample), true);
  assert.deepEqual(restarted.list(), []);
  assert.equal((await fs.stat(directory)).isDirectory(), true);

  const removed = createExtensionManager({ ...options, browserSession: fakeSession(storeExample) });
  await removed.restore();
  assert.deepEqual(removed.list(), []);
});


async function installWorkerFixture(t, startWorkerForScope) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-extension-worker-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const directory = path.join(folder, 'source');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Worker Fixture',
    version: '1.0',
    action: { default_popup: 'popup.html' },
    background: { service_worker: 'worker.js' },
  }));
  const browserSession = fakeSession(storeExample);
  if (startWorkerForScope) browserSession.serviceWorkers = { startWorkerForScope };
  const manager = createExtensionManager({
    browserSession,
    userData: path.join(folder, 'profile'),
    selectDirectory: async () => directory,
    confirmInstall: async () => true,
  });
  assert.equal(await manager.loadUnpacked(), true);
  return manager;
}

test('coalesces concurrent opens and retries a service worker that is still registering', async t => {
  const scopes = [];
  const manager = await installWorkerFixture(t, async scope => {
    scopes.push(scope);
    if (scopes.length === 1) throw new Error('Worker is not registered yet.');
  });
  const popup = 'chrome-extension://' + storeExample + '/popup.html';
  assert.deepEqual(await Promise.all([manager.prepareOpen(storeExample), manager.prepareOpen(storeExample)]), [popup, popup]);
  assert.deepEqual(scopes, Array(2).fill('chrome-extension://' + storeExample + '/'));
  assert.equal(manager.list()[0].runtimeError, null);
});

test('blocks a persistently broken extension without exposing native startup details', async t => {
  const rawDetail = 'Internal extension diagnostic containing private information';
  let failedAttempts = 0;
  let healthy = false;
  const manager = await installWorkerFixture(t, async () => {
    if (healthy) return;
    failedAttempts += 1;
    throw new Error(rawDetail);
  });
  await assert.rejects(manager.prepareOpen(storeExample), error => {
    assert.match(error.message, /could not start this extension/);
    assert.doesNotMatch(error.message, /private information/);
    assert.equal(manager.list()[0].runtimeError, error.message);
    return true;
  });
  assert.equal(failedAttempts, 4);
  assert.equal(manager.list()[0].enabled, true);

  healthy = true;
  assert.equal(await manager.prepareOpen(storeExample), manager.getPageUrl(storeExample));
  assert.equal(manager.list()[0].runtimeError, null);
});

test('a pending worker times out without a persistent incompatibility diagnosis', async t => {
  const manager = await installWorkerFixture(t, () => new Promise(() => {}));
  await assert.rejects(manager.prepareOpen(storeExample), /did not finish starting/);
  assert.equal(manager.list()[0].runtimeError, null);
});

test('keeps declared extension pages usable when the Electron worker API is unavailable', async t => {
  const manager = await installWorkerFixture(t);
  assert.equal(await manager.prepareOpen(storeExample), manager.getPageUrl(storeExample));
  assert.equal(manager.list()[0].runtimeError, null);
});
