'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProviderTools } = require('../src/agent/providers.cjs');

const userDirectory = 'C:\\Users\\Agent User';
const codex = 'C:\\Program Files\\Codex\\codex.exe';
const claude = userDirectory + '\\.local\\bin\\claude.exe';
const workingDirectory = userDirectory + '\\Relay Agent & Workspace';
const url = 'http://127.0.0.1:41729/mcp';
const token = 'a'.repeat(43);
const tokenKey = 'RELAY_BROWSER_MCP_TOKEN';
const launchKey = 'RELAY_BROWSER_TERMINAL_LAUNCH';

test('finds provider executables from standalone, packaged and native npm installations', async () => {
  const packagePath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0_x64';
  const nativeCodex = userDirectory + '\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\' +
    'codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const packaged = packagePath + '\\app\\resources\\codex.exe';
  const first = createProviderTools({
    platform: 'win32', architecture: 'x64', userDirectory,
    environment: { Path: '"C:\\Program Files\\Codex";local-tools;C:\\Vendor Path' },
    fileExists: async candidate => [codex, claude].includes(candidate),
    execute: async () => assert.fail('Standalone installs require no package lookup')
  });
  assert.equal(await first.find('chatgpt'), codex);
  assert.equal(await first.find('claude'), claude);

  for (const target of [nativeCodex, packaged]) {
    const fallback = createProviderTools({
      platform: 'win32', architecture: 'x64', userDirectory, environment: {},
      fileExists: async candidate => candidate === target,
      execute: async (executable, args) => {
        assert.match(executable, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
        assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /Get-AppxPackage -Name 'OpenAI.Codex'/);
        return { code: 0, stdout: packagePath + '\r\n', stderr: '' };
      }
    });
    assert.equal(await fallback.find('chatgpt'), target);
  }
});

test('validates the selected account mode without passing Relay credentials to auth commands', async () => {
  const calls = [
    { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\r\n' },
    { code: 0, stdout: '', stderr: 'API key configured - sk-...123\r\n' },
    { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: '' },
    { code: 1, stdout: '{"loggedIn":false}', stderr: '' }
  ];
  const providers = createProviderTools({
    platform: 'win32', userDirectory, environment: { [tokenKey.toLowerCase()]: token },
    execute: async (tool, args, { cwd, env }) => {
      assert.equal(cwd, userDirectory);
      assert.deepEqual(env, {});
      assert.deepEqual(args, tool === codex ? ['login', 'status'] : ['auth', 'status', '--json']);
      return calls.shift();
    }
  });
  assert.equal(await providers.checkAuth('chatgpt', codex), true);
  assert.equal(await providers.checkAuth('chatgpt', codex), false);
  assert.equal(await providers.checkAuth('claude', claude), true);
  assert.equal(await providers.checkAuth('claude', claude), false);
});

test('starts first-party sign-in and passes only the runtime MCP credential in interactive session environment', async () => {
  const launches = [];
  const source = { [tokenKey]: 'stale', No_Proxy: 'example.test' };
  const providers = createProviderTools({
    platform: 'win32', userDirectory, environment: source,
    execute: async (executable, args, options) => {
      const launch = JSON.parse(options.env[launchKey]);
      assert.match(executable, /\\powershell\.exe$/i);
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /Start-Process -FilePath \$launch\.executable -ArgumentList \$launch\.arguments/);
      assert.ok(!JSON.stringify(args).includes(token));
      assert.ok(!JSON.stringify(launch).includes(token));
      launches.push({ launch, ...options });
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  await providers.signIn('chatgpt', codex, { workingDirectory });
  await providers.signIn('claude', claude);
  await providers.open('chatgpt', codex, { url, token, workingDirectory });
  await providers.open('claude', claude, { url, token, workingDirectory });
  assert.deepEqual(launches[0].launch, { executable: codex, arguments: 'login', directory: workingDirectory, wait: true });
  assert.deepEqual(launches[1].launch, { executable: claude, arguments: 'auth login', directory: userDirectory, wait: true });
  assert.equal(launches[0].env[tokenKey], undefined);
  assert.equal(launches[1].env[tokenKey], undefined);
  assert.equal(launches[2].launch.wait, false);
  assert.match(launches[2].launch.arguments, /mcp_servers\.relay-browser-live=\{url=[^,]+,bearer_token_env_var=/);
  assert.match(launches[3].launch.arguments, /--tools "" --strict-mcp-config --mcp-config/);
  assert.match(launches[3].launch.arguments, /relay-browser-live/);
  assert.match(launches[3].launch.arguments, /Bearer \$\{RELAY_BROWSER_MCP_TOKEN\}/);
  for (const { env, cwd } of launches.slice(2)) {
    assert.equal(env[tokenKey], token);
    assert.equal(env.NO_PROXY, 'example.test,127.0.0.1,localhost');
    assert.equal(cwd, workingDirectory);
  }
  assert.equal(source[tokenKey], 'stale');
});

test('rejects unrecognized providers, commands, paths, and non-loopback endpoints', async () => {
  const providers = createProviderTools({
    platform: 'win32', userDirectory, environment: {},
    execute: async () => assert.fail('Invalid input must fail before executing a process')
  });
  await assert.rejects(providers.find('other'), TypeError);
  await assert.rejects(providers.signIn('chatgpt', 'codex.cmd'), TypeError);
  await assert.rejects(providers.open('chatgpt', codex, { url, token: 'incorrect', workingDirectory }), TypeError);
  await assert.rejects(providers.open('chatgpt', codex, { url, token, workingDirectory: '.' }), TypeError);
  for (const endpoint of ['http://localhost:41729/mcp', 'http://127.0.0.1:41729/mcp?query', 'https://example.test:41729/mcp']) {
    await assert.rejects(providers.open('chatgpt', codex, { url: endpoint, token, workingDirectory }), TypeError);
  }
});
