'use strict';

const { readFile } = require('node:fs/promises');
const { request } = require('node:http');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { isObject, preferenceSchema, validatePreferencesPatch } = require('./preferences.cjs');

const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOLS = ['2025-11-25', '2025-06-18'];
const PROTOCOL_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const SERVER_INFO = { name: 'relay-browser', title: 'Relay Browser', version: '0.1.0' };
const CAPABILITIES = { tools: {} };
const INSTRUCTIONS = 'Use these tools to read or change the user’s Relay Browser preferences. Changes apply immediately.';
const PREFERENCES_PATH = '/v1/preferences';
const TOOL_CATALOG_CACHE = { ttlMs: 300000, cacheScope: 'public' };

const outputSchema = {
  type: 'object',
  properties: preferenceSchema,
  required: Object.keys(preferenceSchema),
  additionalProperties: false
};

const tools = [
  {
    name: 'get_browser_preferences',
    title: 'Read Relay preferences',
    description: 'Read the current Relay Browser tab position, theme, homepage, search provider, and bookmarks bar visibility.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: 'set_browser_preferences',
    title: 'Change Relay preferences',
    description: 'Apply one or more preference changes immediately and return the current preferences. For vertical tabs, set tabPosition to left or right.',
    inputSchema: { type: 'object', properties: preferenceSchema, additionalProperties: false, minProperties: 1 },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function discoveryPath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return process.env.RELAY_AGENT_FILE || join(appData, 'Relay Browser', 'agent-connection.json');
}

async function readConnection() {
  try {
    const { endpoint, token } = JSON.parse(await readFile(discoveryPath(), 'utf8'));
    const port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/v1\/preferences$/.exec(endpoint)?.[1];
    if (!port || Number(port) > 65535 || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    return { port: Number(port), token };
  } catch {
    throw new Error('Enable the local connection from Relay Browser’s Agent panel before using its tools.');
  }
}

async function useBridge(method, patch) {
  const { port, token } = await readConnection();
  const body = patch ? JSON.stringify(patch) : undefined;

  return new Promise((resolve, reject) => {
    const unavailable = () => reject(new Error('Relay Browser is unavailable. Open it and enable the local connection in its Agent panel.'));
    const headers = { Authorization: `Bearer ${token}` };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const client = request({ hostname: '127.0.0.1', port, path: PREFERENCES_PATH, method, agent: false, headers }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        if (response.statusCode === 400 || response.statusCode === 500) {
          reject(new Error('Relay Browser could not apply the requested preference change.'));
        } else {
          unavailable();
        }
        return;
      }

      const chunks = [];
      let size = 0;
      response.on('error', unavailable);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) {
          response.destroy();
          unavailable();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const { preferences } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const validated = validatePreferencesPatch(preferences);
          if (Object.keys(validated).length !== Object.keys(preferenceSchema).length) throw new Error();
          resolve(validated);
        } catch {
          unavailable();
        }
      });
    });
    const timer = setTimeout(() => client.destroy(new Error('Request timed out.')), 4000);
    client.on('error', unavailable);
    client.on('close', () => clearTimeout(timer));
    client.end(body);
  });
}

function toolResult(preferences) {
  return { content: [{ type: 'text', text: JSON.stringify(preferences) }], structuredContent: preferences };
}

async function callTool(params) {
  const args = params.arguments === undefined ? {} : params.arguments;
  try {
    if (params.name === 'get_browser_preferences') {
      if (!isObject(args) || Object.keys(args).length) throw new Error('This tool accepts no arguments.');
      return toolResult(await useBridge('GET'));
    }

    const patch = validatePreferencesPatch(args);
    if (!Object.keys(patch).length) throw new Error('Include at least one preference to update.');
    return toolResult(await useBridge('PATCH', patch));
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
}

function startStdio() {
  let initialized = false;
  let supportsLegacy = false;

  function write(message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  function error(id, code, message, data) {
    write({ id, error: { code, message, data } });
  }

  async function handleRequest(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }

    const id = message?.id;
    const validId = typeof id === 'string' || Number.isInteger(id);
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (id !== undefined && !validId)) {
      error(validId ? id : null, -32600, 'Invalid Request');
      return;
    }

    const { method, params = {} } = message;
    if (id === undefined) {
      if (method === 'notifications/initialized' && supportsLegacy) initialized = true;
      return;
    }
    if (!isObject(params)) {
      error(id, -32602, 'Invalid params');
      return;
    }

    const protocol = params._meta?.[PROTOCOL_KEY];
    const modern = protocol === MODERN_PROTOCOL;
    const reply = result => write({
      id,
      result: modern ? { resultType: 'complete', ...result, _meta: { [SERVER_INFO_KEY]: SERVER_INFO } } : result
    });

    if (method === 'initialize' && protocol === undefined) {
      if (typeof params.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo)) {
        error(id, -32602, 'Invalid initialize params');
        return;
      }
      const version = LEGACY_PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_PROTOCOLS[0];
      supportsLegacy = true;
      reply({ protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      return;
    }

    if (method === 'server/discover' || protocol !== undefined || !supportsLegacy) {
      if (protocol === undefined || (modern && !isObject(params._meta[CAPABILITIES_KEY]))) {
        error(id, -32602, 'A modern MCP request requires protocol and client capabilities metadata.');
        return;
      }
      if (!modern) {
        error(id, -32022, 'Unsupported protocol version', { supported: [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS], requested: protocol });
        return;
      }
    }

    if (method === 'ping') {
      reply({});
      return;
    }
    if (!modern && !initialized) {
      error(id, -32600, 'Initialize the MCP connection first.');
      return;
    }

    switch (method) {
      case 'server/discover':
        reply({ supportedVersions: [MODERN_PROTOCOL], capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ...TOOL_CATALOG_CACHE });
        break;
      case 'tools/list':
        reply(modern ? { tools, ...TOOL_CATALOG_CACHE } : { tools });
        break;
      case 'tools/call':
        if (!tools.some(tool => tool.name === params.name)) {
          error(id, -32602, 'Unknown Relay Browser tool');
          return;
        }
        reply(await callTool(params));
        break;
      default:
        error(id, -32601, 'Method not found');
    }
  }

  return (async () => {
    const lines = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    for await (const line of lines) await handleRequest(line);
  })();
}

startStdio().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
