# Relay Browser

Relay is an open-source Chromium browser for Windows x64. Connect an MCP-compatible agent and ask it to change the browser while you work. Try “Move my tabs to the left and switch to the system theme.” The agent button stays at the upper right, immediately before the Windows window controls, in each tab layout.

## Install on Windows

Download `Relay-Browser-0.1.0-Windows-x64-Setup.exe` from the [latest release](https://github.com/Gobbledegookie/agentic-browser/releases/latest) and run it. The preview installer is unsigned, so Windows may show a SmartScreen prompt. The release includes a SHA-256 checksum.

## Browse and customize

- Search or navigate from the address bar. Relay supports tabs, pinning, session restore, bookmarks, history, downloads, find in page, zoom, and fullscreen.
- Open **Browser menu → Customize Relay** to move tabs to the top, left, or right. You can also set the theme, homepage, search engine, and bookmarks bar.
- Open **Extensions** to install a compatible Chrome Web Store extension by URL or ID, or load an unpacked extension folder. Relay shows declared permissions before installation. Electron supports a subset of Chrome APIs. Extension updates currently require a manual reinstall. See [extension compatibility](docs/extensions.md).
- Open the **Agent** button, enable the connection, and copy the MCP configuration for your client. The agent can read and update the five browser preferences live. The connection listens only on loopback and uses a revocable credential. It starts disabled for a new profile. See the [agent connection guide](docs/agent-connection.md) for Codex, Claude Desktop, and direct API setup.

Relay is a single-window desktop preview built on Electron’s Chromium runtime. It currently has no account sync, bundled AI provider, or automatic browser updates. Install newer releases as they become available to pick up Chromium fixes.

## Develop

Use Windows x64 and Node.js 22.12 or newer.

```powershell
npm ci
npm start
npm run check
npm test
npm run dist
```

The Windows installer is written to `dist/`. The GitHub Actions workflow runs the checks and uploads an installer artifact on pushes and pull requests.

| Location | Responsibility |
| --- | --- |
| `src/main.cjs` | Native Chromium views, navigation, downloads, and window integration |
| `src/renderer/` | Browser controls, tab layouts, new tab page, and settings |
| `src/profile.cjs` | Local profile and address resolution |
| `src/preload.cjs` | IPC boundary for the browser controls |
| `src/extensions.cjs` | Signed Store installation and unpacked extension lifecycle |
| `src/agent/` | Authenticated loopback API and MCP companion |

The browser controls run in a separate Electron session from webpages. Websites run in sandboxed views without Node.js or the browser controls’ preload. The agent API can update only validated browser preferences.

## Contribute

Open an issue or pull request with the Windows version, Relay version, and steps to reproduce or verify the change. Keep browser controls, webpage contents, and agent permissions isolated when extending the app.

Licensed under [MIT](LICENSE).
