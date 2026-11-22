const { createHash, createPublicKey, randomUUID, verify } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const yauzl = require('yauzl');
const { LASTPASS_ID } = require('./lastpass-api.cjs');

const extensionIdPattern = /^[a-p]{32}$/;
const storeOrigins = new Set(['https://clients2.google.com', 'https://clients2.googleusercontent.com']);
const manifestLimit = 2 * 1024 * 1024;
const archiveLimit = 96 * 1024 * 1024;
const extractedLimit = 384 * 1024 * 1024;

// SHA-256 of the Chrome Web Store production publisher's DER public key.
// https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx_verifier.cc
const publisherKeyHash = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf';

function storeListingId(input) {
  if (typeof input !== 'string' || /[\u0000-\u0020\\]/.test(input)) return null;
  // Inspect the supplied path before URL parsing can normalize dot segments.
  const match = /^https:\/\/[^/?#@]+(\/[^?#]*)/i.exec(input);
  if (!match) return null;
  const url = URL.parse(input);
  if (!url || url.username || url.password) return null;

  const prefix = {
    'https://chromewebstore.google.com': '/detail/',
    'https://chrome.google.com': '/webstore/detail/'
  }[url.origin];
  if (!prefix || !match[1].startsWith(prefix)) return null;
  const parts = match[1].slice(prefix.length).replace(/\/$/, '').split('/');
  const id = parts.at(-1);
  if (parts.length > 2 || !extensionIdPattern.test(id)) return null;
  if (parts.length === 2) {
    try {
      if (!/^[\p{L}\p{M}\p{N}_~-][\p{L}\p{M}\p{N}._~-]*$/u.test(decodeURIComponent(parts[0]))) return null;
    } catch {
      return null;
    }
  }
  return id;
}

function storeId(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  const id = extensionIdPattern.test(text) ? text : storeListingId(text);
  if (id) return id;
  throw new Error('Enter a Chrome Web Store listing URL or a 32-letter Chrome extension ID.');
}

async function downloadStorePackage(id, chromeVersion, timeout = 45000) {
  let url = new URL('https://clients2.google.com/service/update2/crx');
  url.search = new URLSearchParams({
    response: 'redirect',
    prodversion: chromeVersion,
    acceptformat: 'crx3',
    x: 'id=' + id + '&installsource=ondemand&uc',
  }).toString();
  const signal = AbortSignal.timeout(timeout);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (!storeOrigins.has(url.origin) || url.username || url.password) {
      throw new Error('The Chrome Web Store sent an unexpected download address.');
    }
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('The Chrome Web Store did not provide a download address.');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('The Chrome Web Store did not provide an installable package for this extension.');
    }
    if (Number(response.headers.get('content-length')) > archiveLimit) {
      await response.body.cancel();
      throw new Error('The extension package is too large.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > archiveLimit) throw new Error('The extension package is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error('The Chrome Web Store sent too many redirects.');
}

// CRX3 uses protobuf length-delimited fields for its header, proofs and signed data.
// https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
function readFields(bytes) {
  const fields = new Map();
  let offset = 0;
  function readVarint() {
    let value = 0;
    for (let shift = 0; shift <= 28 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      if (shift === 28 && byte > 15) break;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error('Invalid Chrome extension package header.');
  }
  while (offset < bytes.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (!field || wireType !== 2) throw new Error('Invalid Chrome extension package header.');
    const length = readVarint();
    const end = offset + length;
    if (end > bytes.length) throw new Error('Truncated Chrome extension package header.');
    if (!fields.has(field)) fields.set(field, []);
    fields.get(field).push(bytes.subarray(offset, end));
    offset = end;
  }
  return fields;
}

function singleField(fields, tag) {
  const values = fields.get(tag);
  if (values?.length !== 1 || values[0].length === 0) {
    throw new Error('Invalid Chrome extension package signature metadata.');
  }
  return values[0];
}

function verifyStorePackage(packageBytes, id) {
  const expectedId = Buffer.from(id.replace(/[a-p]/g, char => (char.charCodeAt(0) - 97).toString(16)), 'hex');
  if (packageBytes.length < 12 || packageBytes.toString('ascii', 0, 4) !== 'Cr24' ||
      packageBytes.readUInt32LE(4) !== 3) {
    throw new Error('Expected a signed Chrome Web Store package in CRX3 format.');
  }
  const headerSize = packageBytes.readUInt32LE(8);
  if (headerSize > 1024 * 1024 || 12 + headerSize >= packageBytes.length) {
    throw new Error('Invalid Chrome extension package header size.');
  }
  const fields = readFields(packageBytes.subarray(12, 12 + headerSize));
  const signedHeader = singleField(fields, 10000);
  if (!singleField(readFields(signedHeader), 1).equals(expectedId)) {
    throw new Error('The downloaded extension ID did not match the requested extension.');
  }
  const archive = packageBytes.subarray(12 + headerSize);
  const signedHeaderSize = Buffer.alloc(4);
  signedHeaderSize.writeUInt32LE(signedHeader.length);
  const signedBytes = Buffer.concat([Buffer.from('CRX3 SignedData\0'), signedHeaderSize, signedHeader, archive]);
  let developerKey;
  let publisherVerified = false;
  const proofTypes = [[2, 'rsa'], [3, 'ec']];
  for (const [tag, algorithm] of proofTypes) {
    const proofs = fields.get(tag) || [];
    if (proofs.length > 8) throw new Error('Too many Chrome extension signature proofs.');
    for (const proofBytes of proofs) {
      const proof = readFields(proofBytes);
      const key = singleField(proof, 1);
      const signature = singleField(proof, 2);
      const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== algorithm || !verify('sha256', signedBytes, publicKey, signature)) {
        throw new Error('The Chrome extension package signature did not verify.');
      }
      const hash = createHash('sha256').update(key).digest();
      if (hash.subarray(0, 16).equals(expectedId)) developerKey = key;
      if (hash.toString('hex') === publisherKeyHash) publisherVerified = true;
    }
  }
  if (!developerKey || !publisherVerified) {
    throw new Error('Required developer or Chrome Web Store publisher signature was missing.');
  }
  return { archive, developerKey };
}

async function extractArchive(bytes, root) {
  const zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: true, autoClose: false });
  const paths = new Map();
  let size = 0;
  try {
    if (zip.entryCount > 10000) throw new Error('The extension contains too many files.');
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      const parts = name.split('/');
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
      const isReparsePoint = Boolean(entry.externalFileAttributes & 0x0400);
      if (isReparsePoint || (fileType && fileType !== (directory ? 0x4000 : 0x8000))) {
        throw new Error('The extension contains a link or special file.');
      }
      if (parts.some(part => !part || /[<>:"\\|?*\u0000-\u001F]/u.test(part) || /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) {
        throw new Error('The extension contains an invalid file name.');
      }
      let prefix = '';
      for (const [index, part] of parts.entries()) {
        prefix = prefix ? prefix + '/' + part : part;
        const normalized = prefix.normalize('NFC').toLowerCase();
        const isFile = !directory && index === parts.length - 1;
        const prior = paths.get(normalized);
        if (prior && (prior.prefix !== prefix || prior.isFile || isFile)) {
          throw new Error('The extension contains conflicting file names.');
        }
        if (!prior) paths.set(normalized, { prefix, isFile });
      }
      size += entry.uncompressedSize;
      if (size > extractedLimit) throw new Error('The uncompressed extension is too large.');
      const target = path.join(root, ...parts);
      if (directory) {
        await fs.mkdir(target, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(target, { flags: 'wx' }));
      }
    }
  } finally {
    zip.close();
  }
}

function manifestKeyId(manifest) {
  if (typeof manifest.key !== 'string') return null;
  const base64 = manifest.key.replace(/-----[^-]*-----/g, '').replace(/\s/g, '');
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

async function readManifest(folder) {
  const location = path.join(folder, 'manifest.json');
  const info = await fs.stat(location);
  if (!info.isFile() || info.size > manifestLimit) throw new Error('Invalid extension manifest.');
  const manifest = JSON.parse((await fs.readFile(location, 'utf8')).replace(/^\uFEFF/, ''));
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('The extension needs a valid manifest with a name and a version.');
  }
  return manifest;
}

async function manifestName(folder, manifest) {
  const messageKey = /^__MSG_(.+)__$/i.exec(manifest.name)?.[1];
  if (!messageKey || !/^[a-z0-9_]{1,40}$/i.test(manifest.default_locale)) return manifest.name;
  try {
    const location = path.join(folder, '_locales', manifest.default_locale, 'messages.json');
    if ((await fs.stat(location)).size > manifestLimit) return manifest.name;
    const messages = JSON.parse(await fs.readFile(location, 'utf8'));
    const key = Object.keys(messages).find(name => name.toLowerCase() === messageKey.toLowerCase());
    return typeof messages[key]?.message === 'string' ? messages[key].message : manifest.name;
  } catch {
    return manifest.name;
  }
}

function permissionDetails(manifest) {
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  const required = strings(manifest.permissions);
  const optional = strings(manifest.optional_permissions);
  const isHost = item => item.includes('://') || item === '<all_urls>';
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  return {
    permissions: [...new Set([...required, ...optional].filter(item => !isHost(item)))],
    hostPermissions: [...new Set([
      ...required.filter(isHost), ...optional.filter(isHost),
      ...strings(manifest.host_permissions), ...strings(manifest.optional_host_permissions),
      ...contentScripts.flatMap(script => strings(script?.matches)),
    ])],
  };
}

function requestedAccess(manifest) {
  const required = permissionDetails({
    permissions: manifest.permissions, host_permissions: manifest.host_permissions, content_scripts: manifest.content_scripts,
  });
  const requested = permissionDetails(manifest);
  return {
    requiredPermissions: required.permissions, requiredHosts: required.hostPermissions,
    requestedPermissions: requested.permissions, requestedHosts: requested.hostPermissions,
  };
}

function accessWithin(approved, requested) {
  return Boolean(approved && Object.keys(requested).every(key =>
    Array.isArray(approved[key]) && requested[key].every(value => approved[key].includes(value))));
}

function approvalFor(bytes, manifest) {
  return { sha256: createHash('sha256').update(bytes).digest('hex'), version: manifest.version, access: requestedAccess(manifest) };
}

function samePath(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  const paths = [path.resolve(first), path.resolve(second)];
  return process.platform === 'win32' ? paths[0].toLowerCase() === paths[1].toLowerCase() : paths[0] === paths[1];
}

const proofError = 'Relay could not verify the signed LastPass package. Remove LastPass and reinstall it from the Chrome Web Store.';
const proofNetworkError = 'Relay could not verify LastPass with the Chrome Web Store. Check your connection and restart Relay or reinstall LastPass.';
const proofPermissionsError = 'LastPass now requests new permissions or site access. Remove it and reinstall it from the Chrome Web Store to review the changes.';

class LastPassProofError extends Error {}

function extensionPage(extension) {
  const { manifest, id } = extension;
  const page = manifest.action?.default_popup || manifest.browser_action?.default_popup ||
    manifest.page_action?.default_popup || manifest.options_ui?.page || manifest.options_page;
  if (typeof page !== 'string') return null;
  try {
    const url = new URL(page, 'chrome-extension://' + id + '/');
    if (url.protocol === 'chrome-extension:' && url.hostname === id &&
        !url.username && !url.password && !url.port && url.pathname !== '/') return url.href;
  } catch {
    // Ignore malformed manifest page entries.
  }
  return null;
}

const workerStartupError = 'Relay could not start this extension’s background service worker. It may require Chrome APIs that Relay does not support.';
const workerTimeoutError = 'The extension’s background service worker did not finish starting. Try opening the extension again.';

async function startExtensionWorker(serviceWorkers, scope) {
  const deadline = performance.now() + 3000;
  // Chromium can still be registering a service worker immediately after the extension loads.
  for (const pause of [0, 150, 400, 850]) {
    if (pause) await delay(Math.min(pause, Math.max(0, deadline - performance.now())));
    const remaining = deadline - performance.now();
    if (remaining <= 0) return 'timeout';
    let timeout;
    const deadlineResult = new Promise(resolve => { timeout = setTimeout(resolve, remaining, 'timeout'); });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => serviceWorkers.startWorkerForScope(scope)).then(() => 'started', () => 'failed'),
        deadlineResult,
      ]);
      if (result !== 'failed') return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  return 'failed';
}

function createExtensionManager({ browserSession, userData, selectDirectory, confirmInstall }) {
  const extensions = browserSession.extensions;
  const root = path.resolve(userData, 'extensions');
  const registryPath = path.join(root, 'registry.json');
  const records = new Map();
  const storeManifests = new Map();
  const workerProbes = new WeakMap();
  const runtimeErrors = new WeakMap();
  let queue = Promise.resolve();
  let restorePromise;

  function serialize(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }

  function installedPath(record) {
    return record.source === 'store' ? path.join(root, record.id) : record.directory;
  }

  async function writeAtomically(file, contents) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, contents, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function save(entries) {
    const persisted = entries.map(({ id, source, directory, name, version, approvedPackage }) =>
      ({ id, source, directory, name, version, approvedPackage }));
    await writeAtomically(registryPath, JSON.stringify(persisted, null, 2));
  }

  async function ensureRegistryRoot() {
    await fs.mkdir(root, { recursive: true });
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Relay’s extension storage must be a regular directory.');
    }
  }

  async function removeManagedDirectory(directory) {
    if (path.dirname(path.resolve(directory)) !== root) {
      throw new Error('Invalid managed extension directory.');
    }
    await ensureRegistryRoot();
    await fs.rm(directory, { recursive: true, force: true });
  }

  function proofPath() {
    return path.join(root, LASTPASS_ID + '.crx');
  }

  async function readProof() {
    try {
      const info = await fs.lstat(proofPath());
      if (!info.isFile() || info.isSymbolicLink() || info.size > archiveLimit) throw new LastPassProofError(proofError);
      return await fs.readFile(proofPath());
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readInstalledManifest(record) {
    const folder = installedPath(record);
    if (record.source === 'store') {
      const info = await fs.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Relay’s extension package folder is invalid.');
    }
    return readManifest(folder);
  }

  async function load(record, verifiedManifest = null) {
    const folder = installedPath(record);
    const manifest = await readInstalledManifest(record);
    const keyId = manifestKeyId(manifest);
    if (record.id && keyId && record.id !== keyId) throw new Error('The extension ID changed.');
    if (record.source === 'store' && !keyId) throw new Error('Missing Chrome Web Store extension key.');

    const grant = record.id === LASTPASS_ID && record.source === 'store' && verifiedManifest
      ? { folder, manifest: verifiedManifest, loading: true }
      : null;
    if (grant) {
      if (JSON.stringify(manifest) !== JSON.stringify(verifiedManifest)) throw new LastPassProofError(proofError);
      storeManifests.set(record.id, grant);
    }
    try {
      const extension = await extensions.loadExtension(folder, { allowFileAccess: false });
      if ((record.id && record.id !== extension.id) || (grant && !samePath(extension.path, folder))) {
        extensions.removeExtension(extension.id);
        throw new Error('The loaded extension did not match its verified installation.');
      }
      return extension;
    } catch (error) {
      if (grant) storeManifests.delete(record.id);
      throw error;
    }
  }

  function finishVerifiedLoad(id) {
    const grant = storeManifests.get(id);
    if (grant) grant.loading = false;
  }

  async function withStorePackage(id, bytes, use) {
    const { archive, developerKey } = verifyStorePackage(bytes, id);
    const staging = await fs.mkdtemp(path.join(root, 'staging-'));
    let promoted = false;
    try {
      await extractArchive(archive, staging);
      const manifest = await readManifest(staging);
      return await use(staging, manifest, async () => {
        const folder = installedPath({ id, source: 'store' });
        manifest.key = developerKey.toString('base64');
        await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
        await removeManagedDirectory(folder);
        await fs.rename(staging, folder);
        promoted = true;
      });
    } finally {
      if (!promoted) await removeManagedDirectory(staging).catch(() => {});
    }
  }

  async function restoreLastPass(record) {
    let bytes = await readProof();
    const previous = record.approvedPackage;
    if (previous !== undefined && !bytes) throw new LastPassProofError(proofError);
    let legacyAccess;
    if (previous === undefined) {
      const manifest = await readInstalledManifest(record);
      if (manifestKeyId(manifest) !== LASTPASS_ID || manifest.version !== record.version) {
        throw new LastPassProofError(proofError);
      }
      legacyAccess = requestedAccess(manifest);
      if (!bytes) {
        try {
          bytes = await downloadStorePackage(LASTPASS_ID, process.versions.chrome, 10000);
        } catch {
          throw new LastPassProofError(proofNetworkError);
        }
      }
    }

    return withStorePackage(LASTPASS_ID, bytes, async (_folder, manifest, promote) => {
      const approval = approvalFor(bytes, manifest);
      if (!accessWithin(previous === undefined ? legacyAccess : previous?.access, approval.access)) {
        throw new LastPassProofError(proofPermissionsError);
      }
      if (previous !== undefined && (previous.sha256 !== approval.sha256 ||
          previous.version !== approval.version || record.version !== approval.version)) {
        throw new LastPassProofError(proofError);
      }
      if (previous === undefined) {
        await writeAtomically(proofPath(), bytes);
        record.approvedPackage = approval;
        record.version = approval.version;
        await save([...records.values()]);
      }
      await promote();
      return load(record, manifest);
    });
  }

  function restore() {
    restorePromise ??= serialize(async () => {
      await ensureRegistryRoot();
      let entries;
      try {
        entries = JSON.parse(await fs.readFile(registryPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (!Array.isArray(entries)) throw new Error('Invalid Relay extension registry.');
      for (const record of entries) {
        if (!record || typeof record.id !== 'string' || !extensionIdPattern.test(record.id) || records.has(record.id) ||
            !['store', 'unpacked'].includes(record.source) ||
            (record.source === 'unpacked' && (typeof record.directory !== 'string' || !path.isAbsolute(record.directory)))) {
          continue;
        }
        records.set(record.id, record);
      }
      for (const record of records.values()) {
        const needsProof = record.id === LASTPASS_ID && record.source === 'store';
        try {
          const extension = await (needsProof ? restoreLastPass(record) : load(record));
          record.name = extension.name;
          record.version = extension.version;
          finishVerifiedLoad(record.id);
        } catch (error) {
          record.error = error instanceof LastPassProofError ? error.message : needsProof ? proofError :
            'Unable to load. Verify the folder still exists and the extension is compatible.';
        }
      }
    });
    return restorePromise;
  }

  function list() {
    return [...records.values()].map(record => {
      const extension = extensions.getExtension(record.id);
      return {
        id: record.id,
        name: extension?.name || record.name || record.id,
        version: extension?.version || record.version || '',
        description: extension?.manifest?.description || '',
        source: record.source,
        enabled: Boolean(extension),
        error: record.error || null,
        runtimeError: runtimeErrors.get(record) || null,
        hasPage: Boolean(extension && extensionPage(extension)),
      };
    });
  }

  async function approve(folder, manifest, source) {
    return confirmInstall({
      name: await manifestName(folder, manifest),
      version: manifest.version,
      source,
      ...permissionDetails(manifest),
    });
  }

  async function register(extension, source, directory, approvedPackage) {
    const record = { id: extension.id, name: extension.name, version: extension.version, source, directory, approvedPackage };
    try {
      await save([...records.values(), record]);
    } catch (error) {
      if (source === 'store') storeManifests.delete(record.id);
      extensions.removeExtension(record.id);
      throw error;
    }
    records.set(record.id, record);
    finishVerifiedLoad(record.id);
    return true;
  }

  async function loadUnpacked() {
    await restore();
    return serialize(async () => {
      const selected = await selectDirectory();
      if (!selected) return false;
      const directory = await fs.realpath(selected);
      if ([...records.values()].some(record => installedPath(record) === directory)) {
        throw new Error('This extension folder is already registered.');
      }
      const manifest = await readManifest(directory);
      if (records.has(manifestKeyId(manifest))) throw new Error('An extension with this ID is already registered.');
      if (!await approve(directory, manifest, 'unpacked')) return false;
      const extension = await load({ source: 'unpacked', directory });
      return register(extension, 'unpacked', directory);
    });
  }

  async function installFromStore(input) {
    const id = storeId(input);
    await restore();
    return serialize(async () => {
      if (records.has(id)) throw new Error('This extension is already registered.');
      const bytes = await downloadStorePackage(id, process.versions.chrome);
      return withStorePackage(id, bytes, async (staging, manifest, promote) => {
        if (!await approve(staging, manifest, 'store')) return false;
        const approval = id === LASTPASS_ID ? approvalFor(bytes, manifest) : undefined;
        if (approval) await writeAtomically(proofPath(), bytes);
        try {
          await promote();
          const extension = await load({ id, source: 'store' }, approval ? manifest : null);
          return await register(extension, 'store', undefined, approval);
        } catch (error) {
          storeManifests.delete(id);
          await removeManagedDirectory(installedPath({ id, source: 'store' })).catch(() => {});
          if (approval) await fs.rm(proofPath(), { force: true }).catch(() => {});
          throw error;
        }
      });
    });
  }

  async function remove(id) {
    await restore();
    return serialize(async () => {
      const record = records.get(id);
      if (!record) return false;
      await save([...records.values()].filter(entry => entry.id !== id));
      storeManifests.delete(id);
      if (extensions.getExtension(id)) extensions.removeExtension(id);
      records.delete(id);
      if (record.source === 'store') {
        await removeManagedDirectory(installedPath(record)).catch(() => {});
        if (id === LASTPASS_ID) await fs.rm(proofPath(), { force: true }).catch(() => {});
      }
      return true;
    });
  }

  function getPageUrl(id) {
    const extension = records.has(id) && extensions.getExtension(id);
    return extension ? extensionPage(extension) : null;
  }

  async function prepareOpen(id) {
    await restore();
    const record = records.get(id);
    const extension = record && extensions.getExtension(id);
    const page = extension && extensionPage(extension);
    if (!page) return null;

    const serviceWorkers = browserSession.serviceWorkers;
    if (!extension.manifest.background?.service_worker || typeof serviceWorkers?.startWorkerForScope !== 'function') {
      return page;
    }

    let probe = workerProbes.get(record);
    if (!probe) {
      probe = startExtensionWorker(serviceWorkers, 'chrome-extension://' + id + '/')
        .finally(() => workerProbes.delete(record));
      workerProbes.set(record, probe);
    }
    const result = await probe;
    if (records.get(id) !== record || getPageUrl(id) !== page) return null;
    if (result === 'started') {
      runtimeErrors.delete(record);
      return page;
    }
    if (result === 'timeout') throw new Error(workerTimeoutError);
    runtimeErrors.set(record, workerStartupError);
    throw new Error(workerStartupError);
  }

  function getStoreExtension(id) {
    const grant = storeManifests.get(id);
    if (!grant) return null;
    const native = extensions.getExtension(id);
    if (native && !samePath(native.path, grant.folder)) return null;
    if (!grant.loading && (!native || records.get(id)?.source !== 'store')) return null;
    return { id, manifest: grant.manifest };
  }

  return { restore, list, loadUnpacked, installFromStore, remove, getPageUrl, prepareOpen, getStoreExtension };
}

module.exports = { createExtensionManager, storeId, storeListingId, verifyStorePackage };
