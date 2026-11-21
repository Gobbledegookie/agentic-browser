'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { mkdir, rename, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { dirname } = require('node:path');
const { createMcpResponder, rpcError } = require('./mcp.cjs');
const { isObject, publicPreferences, validatePreferencesPatch } = require('./preferences.cjs');

const HOST = '127.0.0.1';
const PREFERENCES_PATH = '/v1/preferences';
const BROWSER_PATH = '/v1/browser';
const PROVIDER_PATH = '/mcp';
const MAX_PREFERENCES_BYTES = 8192;
const MAX_BROWSER_BODY_BYTES = 256 * 1024;
const MAX_MCP_BODY_BYTES = MAX_BROWSER_BODY_BYTES + 8192;
const SERVER_OPTIONS = { headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000 };

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

function isDirectClient(request, server) {
  const address = server?.address();
  return address && request.headers.host === `${HOST}:${address.port}` &&
    request.headers.origin === undefined && request.headers['sec-fetch-site'] === undefined;
}

async function readJson(request, response, limit, formatError = message => ({ error: message })) {
  const fail = (status, message, code = -32600) => {
    respond(response, status, formatError(message, code));
    return null;
  };
  const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    response.setHeader('Connection', 'close');
    return fail(415, 'Send application/json.');
  }
  if (Number(request.headers['content-length']) > limit) {
    response.setHeader('Connection', 'close');
    return fail(413, 'Request body is too large.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      response.setHeader('Connection', 'close');
      return fail(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return fail(400, 'Invalid JSON.', -32700);
  }

  if (!isObject(payload)) {
    return fail(400, 'Request body must be a JSON object.');
  }
  return payload;
}

function commandFrom(payload) {
  const { name, arguments: args = {} } = payload;
  if (Object.keys(payload).some(key => key !== 'name' && key !== 'arguments') ||
      typeof name !== 'string' || !/^[a-z][A-Za-z0-9]{0,63}$/.test(name) || !isObject(args)) {
    throw new TypeError('Send a browser command name and an optional arguments object.');
  }
  return { name, args };
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function createAgentBridge({
  getPreferences, updatePreferences, getBrowserState, listBrowserCommands, runBrowserCommand,
  getCustomization, updateCustomization, resetCustomization, onStatus = () => {}, discoveryPath
}) {
  let connection = null;
  let transition = Promise.resolve();
  let providerServer = null;
  let stopped = false;
  const providerGrants = new Map();
  const handleMcpMessage = createMcpResponder({ http: true });

  const routes = new Map();

  function route(path, method, handler, limit) {
    if (!routes.has(path)) routes.set(path, new Map());
    routes.get(path).set(method, { handler, limit });
  }

  const preferencesResult = async () => ({ preferences: publicPreferences(await getPreferences()) });
  route(PREFERENCES_PATH, 'GET', preferencesResult);
  route(PREFERENCES_PATH, 'PATCH', async payload => {
    const patch = validatePreferencesPatch(payload);
    if (Object.keys(patch).length === 0) throw new TypeError('Include at least one preference to update.');
    await updatePreferences(patch);
    return preferencesResult();
  }, MAX_PREFERENCES_BYTES);

  if (getBrowserState) route(`${BROWSER_PATH}/state`, 'GET', async () => ({ state: await getBrowserState() }));
  if (listBrowserCommands) route(`${BROWSER_PATH}/commands`, 'GET', async () => ({ commands: await listBrowserCommands() }));
  if (runBrowserCommand) {
    route(`${BROWSER_PATH}/commands`, 'POST', async payload => {
      const { name, args } = commandFrom(payload);
      return { result: (await runBrowserCommand(name, args)) ?? null };
    }, MAX_BROWSER_BODY_BYTES);
  }
  if (getCustomization) {
    const customizationResult = async () => ({ customization: await getCustomization() });
    route(`${BROWSER_PATH}/customization`, 'GET', customizationResult);
    if (updateCustomization) {
      route(`${BROWSER_PATH}/customization`, 'PATCH', async payload => {
        if (!Object.keys(payload).length) throw new TypeError('Include at least one customization field to update.');
        await updateCustomization(payload);
        return customizationResult();
      }, MAX_BROWSER_BODY_BYTES);
    }
    if (resetCustomization) {
      route(`${BROWSER_PATH}/customization`, 'DELETE', async () => {
        await resetCustomization();
        return customizationResult();
      });
    }
  }

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
      if (stopped) throw new Error('The agent bridge has stopped.');
      if (connection) return status();

      const token = randomBytes(32).toString('base64url');
      const authorization = `Bearer ${token}`;
      const server = createServer(SERVER_OPTIONS, async (request, response) => {
        if (!isDirectClient(request, server)) {
          respond(response, 403, { error: 'Only direct local clients are allowed.' });
          return;
        }
        if (!isAuthorized(request.headers.authorization, authorization)) {
          respond(response, 401, { error: 'A valid bearer token is required.' });
          return;
        }
        const methods = routes.get(request.url);
        if (!methods) {
          respond(response, 404, { error: 'Unknown endpoint.' });
          return;
        }
        const route = methods.get(request.method);
        if (!route) {
          response.setHeader('Allow', [...methods.keys()].join(', '));
          respond(response, 405, { error: 'Method not allowed.' });
          return;
        }

        try {
          const payload = route.limit ? await readJson(request, response, route.limit) : undefined;
          if (payload === null || response.destroyed) return;
          if (connection?.server !== server) {
            respond(response, 503, { error: 'The agent bridge is disabled.' });
            return;
          }
          respond(response, 200, await route.handler(payload));
        } catch (error) {
          if (response.destroyed) return;
          if (error instanceof TypeError || error instanceof RangeError) {
            respond(response, 400, { error: error.message });
          } else {
            respond(response, 500, { error: 'Relay could not complete the request.' });
          }
        }
      });

      await listen(server);
      const endpoint = `http://${HOST}:${server.address().port}${PREFERENCES_PATH}`;
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

  async function stopManual() {
    const previous = connection;
    connection = null;
    if (previous) await closeServer(previous.server);
    try {
      if (discoveryPath) await rm(discoveryPath, { force: true });
    } finally {
      if (previous) onStatus(status());
    }
    return status();
  }

  async function handleProviderRequest(request, response) {
    if (!isDirectClient(request, providerServer)) {
      respond(response, 403, { error: 'Only direct local clients are allowed.' });
      return;
    }
    const grant = [...providerGrants.values()].find(({ authorization }) => isAuthorized(request.headers.authorization, authorization));
    if (!grant) {
      respond(response, 401, { error: 'A valid provider bearer token is required.' });
      return;
    }
    if (request.url !== PROVIDER_PATH) {
      respond(response, 404, { error: 'Unknown endpoint.' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      respond(response, 405, { error: 'Method not allowed.' });
      return;
    }
    const accept = (request.headers.accept || '').toLowerCase().split(',').map(item => item.split(';', 1)[0].trim());
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      respond(response, 406, rpcError(null, -32600, 'The MCP client must accept JSON and event streams.'));
      return;
    }

    grant.responses.add(response);
    response.once('close', () => grant.responses.delete(response));
    try {
      const message = await readJson(request, response, MAX_MCP_BODY_BYTES, (error, code) => rpcError(null, code, error));
      if (!message || response.destroyed) return;
      const reply = await handleMcpMessage(message, request.headers, async ({ method, path }, payload) => {
        if (response.destroyed) throw new Error('The provider request was disconnected.');
        const route = routes.get(path)?.get(method);
        if (!route) throw new Error('This command is unavailable in Relay.');
        if (route.limit && Buffer.byteLength(JSON.stringify(payload)) > route.limit) throw new TypeError('Request body is too large.');
        try {
          return await route.handler(payload);
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError) throw error;
          throw new Error('Relay could not complete the request.');
        }
      });
      if (response.destroyed) return;
      if (!reply) {
        response.writeHead(202, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      const code = reply.error?.code;
      respond(response, code === -32601 ? 404 : code ? 400 : 200, reply);
    } catch {
      if (!response.destroyed) respond(response, 500, rpcError(null, -32603, 'Relay could not complete the request.'));
    }
  }

  function grantProvider(id) {
    return serialize(async () => {
      if (stopped) throw new Error('The agent bridge has stopped.');
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new TypeError('Unknown provider ID.');
      const existing = providerGrants.get(id);
      if (existing) return { url: existing.url, token: existing.token };
      if (!providerServer) {
        const server = createServer(SERVER_OPTIONS, handleProviderRequest);
        await listen(server);
        providerServer = server;
      }
      const token = randomBytes(32).toString('base64url');
      const url = `http://${HOST}:${providerServer.address().port}${PROVIDER_PATH}`;
      providerGrants.set(id, { url, token, authorization: `Bearer ${token}`, responses: new Set() });
      return { url, token };
    });
  }

  async function closeProviderServer() {
    const server = providerServer;
    providerServer = null;
    if (server) await closeServer(server);
  }

  function revokeProvider(id) {
    return serialize(async () => {
      const previous = providerGrants.get(id);
      if (!previous) return;
      providerGrants.delete(id);
      for (const response of previous.responses) response.destroy();
      if (!providerGrants.size) await closeProviderServer();
    });
  }

  function shutdown() {
    return serialize(async () => {
      stopped = true;
      providerGrants.clear();
      const results = await Promise.allSettled([stopManual(), closeProviderServer()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
  }

  return { start, status, stop: () => serialize(stopManual), grantProvider, revokeProvider, shutdown };
}

module.exports = { createAgentBridge };
