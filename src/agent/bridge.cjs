'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { mkdir, rename, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { dirname } = require('node:path');
const { publicPreferences, validatePreferencesPatch } = require('./preferences.cjs');

const HOST = '127.0.0.1';
const PATH = '/v1/preferences';
const MAX_BODY_BYTES = 8192;

function respond(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function isAuthorized(value, expected) {
  if (typeof value !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

async function readPatch(request, response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      response.setHeader('Connection', 'close');
      respond(response, 413, { error: 'Request body is too large.' });
      return null;
    }
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    respond(response, 400, { error: 'Invalid JSON.' });
    return null;
  }

  try {
    const patch = validatePreferencesPatch(payload);
    if (Object.keys(patch).length === 0) throw new TypeError('Include at least one preference to update.');
    return patch;
  } catch (error) {
    respond(response, 400, { error: error.message });
    return null;
  }
}

async function writeDiscoveryFile(path, info) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function createAgentBridge({ getPreferences, updatePreferences, onStatus = () => {}, discoveryPath }) {
  let connection = null;
  let transition = Promise.resolve();

  function status() {
    if (!connection) return { enabled: false, endpoint: '', token: '' };
    const { endpoint, token } = connection;
    return { enabled: true, endpoint, token };
  }

  function serialize(operation) {
    const next = transition.then(operation);
    transition = next.catch(() => {});
    return next;
  }

  function start() {
    return serialize(async () => {
      if (connection) return status();

      const token = randomBytes(32).toString('base64url');
      const authorization = `Bearer ${token}`;
      const server = createServer({ headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000 }, async (request, response) => {
        if (request.headers.host !== `${HOST}:${server.address()?.port}` ||
            request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
          respond(response, 403, { error: 'Only direct local clients are allowed.' });
          return;
        }
        if (!isAuthorized(request.headers.authorization, authorization)) {
          respond(response, 401, { error: 'A valid bearer token is required.' });
          return;
        }
        if (request.url !== PATH) {
          respond(response, 404, { error: 'Unknown endpoint.' });
          return;
        }
        if (request.method !== 'GET' && request.method !== 'PATCH') {
          response.setHeader('Allow', 'GET, PATCH');
          respond(response, 405, { error: 'Method not allowed.' });
          return;
        }

        try {
          if (request.method === 'PATCH') {
            const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
            if (mediaType !== 'application/json') {
              respond(response, 415, { error: 'Send application/json.' });
              return;
            }
            const patch = await readPatch(request, response);
            if (!patch) return;
            if (connection?.server !== server) {
              respond(response, 503, { error: 'The agent bridge is disabled.' });
              return;
            }
            await updatePreferences(patch);
          }
          respond(response, 200, { preferences: publicPreferences(await getPreferences()) });
        } catch {
          if (!response.destroyed) respond(response, 500, { error: 'Relay could not process the preference request.' });
        }
      });

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const endpoint = `http://${HOST}:${server.address().port}${PATH}`;
      try {
        if (discoveryPath) await writeDiscoveryFile(discoveryPath, { endpoint, token });
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      connection = { server, endpoint, token };
      onStatus(status());
      return status();
    });
  }

  function stop() {
    return serialize(async () => {
      const previous = connection;
      connection = null;
      if (previous) await closeServer(previous.server);
      try {
        if (discoveryPath) await rm(discoveryPath, { force: true });
      } finally {
        if (previous) onStatus(status());
      }
      return status();
    });
  }

  return { start, status, stop };
}

module.exports = { createAgentBridge };
