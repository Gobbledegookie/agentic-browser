'use strict';

const { execFile } = require('node:child_process');
const { stat } = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path').win32;

const TOKEN_ENV = 'RELAY_BROWSER_MCP_TOKEN';
const LAUNCH_ENV = 'RELAY_BROWSER_TERMINAL_LAUNCH';
const PROVIDERS = {
  chatgpt: { name: 'Codex', file: 'codex.exe', status: ['login', 'status'], login: ['login'] },
  claude: { name: 'Claude Code', file: 'claude.exe', status: ['auth', 'status', '--json'], login: ['auth', 'login'] }
};

const START_TERMINAL = [
  "$ErrorActionPreference = 'Stop'",
  "$launch = ConvertFrom-Json -InputObject $env:" + LAUNCH_ENV,
  "Remove-Item -LiteralPath Env:" + LAUNCH_ENV,
  "$process = Start-Process -FilePath $launch.executable -ArgumentList $launch.arguments -WorkingDirectory $launch.directory -WindowStyle Normal -PassThru",
  "if ($launch.wait) { $process.WaitForExit(); exit $process.ExitCode }"
].join('\n');

const FIND_CODEX_PACKAGE = [
  "Get-AppxPackage -Name 'OpenAI.Codex'",
  "Sort-Object Version -Descending",
  "Select-Object -First 1 -ExpandProperty InstallLocation"
].join(' | ');

function provider(id) {
  if (!Object.hasOwn(PROVIDERS, id)) throw new TypeError('Choose ChatGPT or Claude.');
  return PROVIDERS[id];
}

function isLocalPath(value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !/[\u0000-\u001f"]/.test(value);
}

function validateExecutable(id, executable) {
  const selected = provider(id);
  if (!isLocalPath(executable) || path.basename(executable).toLowerCase() !== selected.file) {
    throw new TypeError('An installed ' + selected.name + ' executable is required.');
  }
  return selected;
}

function validatedConnection(url, token) {
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/mcp$/.test(url) || !URL.canParse(url)) {
    throw new TypeError('Relay MCP requires a direct Windows loopback URL.');
  }
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) {
    throw new TypeError('Relay MCP requires an active connection token.');
  }
}

function interactiveArgs(id, url) {
  const server = 'relay-browser-live';
  if (id === 'chatgpt') {
    // Codex merges config tables. Give the session a separate name from the
    // legacy stdio Relay entry to keep its transport settings independent.
    const mcp = 'mcp_servers.' + server + '={url=' + JSON.stringify(url) +
      ',bearer_token_env_var=' + JSON.stringify(TOKEN_ENV) + '}';
    return [
      '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
      '-c', mcp, '-c', 'shell_environment_policy.inherit="none"'
    ];
  }
  const config = { mcpServers: { [server]: {
    type: 'http', url, headers: { Authorization: 'Bearer $' + '{' + TOKEN_ENV + '}' }
  } } };
  return [
    '--permission-mode', 'default', '--no-chrome', '--tools', '',
    '--strict-mcp-config', '--mcp-config', JSON.stringify(config)
  ];
}

// Start-Process flattens ArgumentList into a Windows command line. Quote each
// value for the native argv parser before passing it as a single argument list.
function quoteWindowsArgument(value) {
  if (value.length && !/[\s"]/.test(value)) return value;
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&');
  return '"' + escaped + '"';
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function run(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, maxBuffer: 64 * 1024, ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error.code === 'ABORT_ERR' ? error : new Error('Windows could not run the provider command.'));
      } else {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    });
  });
}

function cleanEnvironment(source) {
  const env = { ...source };
  // Windows environment names are case-insensitive.
  for (const key of Object.keys(env)) {
    if ([TOKEN_ENV, LAUNCH_ENV].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

function allowLoopback(env) {
  const previous = Object.keys(env).find(key => key.toUpperCase() === 'NO_PROXY');
  const exclusions = [env[previous], '127.0.0.1', 'localhost'].filter(Boolean);
  if (previous) delete env[previous];
  env.NO_PROXY = exclusions.join(',');
}

function createProviderTools({
  environment = process.env, userDirectory = homedir(), platform = process.platform, architecture = process.arch,
  fileExists = isFile, execute = run
} = {}) {
  const windowsDirectory = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  function runPowerShell(script, options) {
    const code = Buffer.from(script, 'utf16le').toString('base64');
    return execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', code], options);
  }

  async function find(id) {
    const selected = provider(id);
    if (platform !== 'win32') return null;
    const envPath = Object.keys(environment).find(key => key.toUpperCase() === 'PATH');
    const localApps = environment.LOCALAPPDATA || path.join(userDirectory, 'AppData', 'Local');
    const npm = environment.APPDATA || path.join(userDirectory, 'AppData', 'Roaming');
    const directories = [
      ...(environment[envPath] || '').split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')),
      path.join(userDirectory, '.local', 'bin'),
      path.join(localApps, 'Microsoft', 'WinGet', 'Links'),
      path.join(localApps, 'Microsoft', 'WindowsApps'),
      path.join(npm, 'npm')
    ].filter(isLocalPath);
    const suffix = architecture === 'arm64' ? 'arm64' : 'x64';
    const triple = architecture === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const candidates = [];
    for (const directory of directories) {
      candidates.push(path.join(directory, selected.file));
      const modules = path.join(directory, 'node_modules');
      if (id === 'chatgpt') {
        const codex = path.join(modules, '@openai', 'codex');
        const nativePackage = ['@openai', 'codex-win32-' + suffix];
        for (const base of [path.join(codex, 'node_modules', ...nativePackage), path.join(modules, ...nativePackage), codex]) {
          const vendor = path.join(base, 'vendor', triple);
          candidates.push(path.join(vendor, 'bin', selected.file), path.join(vendor, 'codex', selected.file));
        }
      } else {
        candidates.push(path.join(modules, '@anthropic-ai', 'claude-code', 'bin', selected.file));
      }
    }
    for (const candidate of new Set(candidates)) {
      if (await fileExists(candidate)) return candidate;
    }
    if (id === 'chatgpt') {
      try {
        const result = await runPowerShell(FIND_CODEX_PACKAGE, { timeout: 8000, env: cleanEnvironment(environment) });
        const folder = result.stdout.trim();
        if (result.code === 0 && isLocalPath(folder)) {
          const candidate = path.join(folder, 'app', 'resources', selected.file);
          if (await fileExists(candidate)) return candidate;
        }
      } catch {
        // Standalone Codex and the Microsoft Store app are separate installs.
      }
    }
    return null;
  }

  async function checkAuth(id, executable, { signal } = {}) {
    signal?.throwIfAborted();
    const selected = validateExecutable(id, executable);
    const result = await execute(executable, selected.status, {
      cwd: userDirectory, env: cleanEnvironment(environment), timeout: 15000, signal
    });
    if (result.code === 1) return false;
    if (result.code !== 0) throw new Error('Could not check ' + selected.name + ' sign-in.');
    if (id === 'chatgpt') return /(?:^|\r?\n)Logged in using ChatGPT[ \t]*(?:\r?\n|$)/i.test(result.stdout + '\n' + result.stderr);
    try {
      const status = JSON.parse(result.stdout);
      return status.loggedIn === true && status.authMethod === 'claude.ai';
    } catch {
      throw new Error('Claude Code could not report its sign-in status. Update Claude Code and retry.');
    }
  }

  async function terminal(executable, args, { directory, env, wait, signal }) {
    if (platform !== 'win32' || !isLocalPath(directory)) throw new TypeError('A Windows agent workspace is required.');
    env[LAUNCH_ENV] = JSON.stringify({
      executable, arguments: args.map(quoteWindowsArgument).join(' '), directory, wait
    });
    const result = await runPowerShell(START_TERMINAL, {
      cwd: directory, env, signal, timeout: wait ? 10 * 60 * 1000 : 15000
    });
    if (result.code !== 0) throw new Error(wait ? 'Provider sign-in did not complete.' : 'Could not launch the agent terminal.');
  }

  async function signIn(id, executable, { signal, workingDirectory = userDirectory } = {}) {
    signal?.throwIfAborted();
    const selected = validateExecutable(id, executable);
    await terminal(executable, selected.login, {
      directory: workingDirectory, env: cleanEnvironment(environment), wait: true, signal
    });
  }

  async function open(id, executable, { url, token, workingDirectory }) {
    validateExecutable(id, executable);
    validatedConnection(url, token);
    const env = cleanEnvironment(environment);
    allowLoopback(env);
    env[TOKEN_ENV] = token;
    await terminal(executable, interactiveArgs(id, url), { directory: workingDirectory, env, wait: false });
  }

  return { find, checkAuth, signIn, open };
}

module.exports = { createProviderTools };
