# Relay Browser

Relay is an open-source Chromium browser for Windows x64. Connect an MCP-compatible agent and ask it to change the browser while you work. Try “Move my tabs to the left and switch to the system theme.” The agent button stays at the upper right, immediately before the Windows window controls, in each tab layout.

## Install on Windows

Download the Windows x64 setup file from the [latest release](https://github.com/Gobbledegookie/agentic-browser/releases/latest) and run it. The preview installer is unsigned, so Windows may show a SmartScreen prompt. The release includes a SHA-256 checksum.

## Browse and customize

- Search or navigate from the address bar. On your first search, choose Google, DuckDuckGo, or Bing. Relay remembers your choice and opens your results. Relay also supports tabs, pinning, session restore, bookmarks, history, downloads, find in page, zoom, and fullscreen.
- Open **Browser menu → Customize Relay** to move tabs to the top, left, or right. You can also set the theme, homepage, search engine, and bookmarks bar.
- On a Chrome Web Store extension listing, click **Add to Relay** in the browser toolbar. You can also install by URL or ID or load an unpacked folder from **Extensions**. Relay shows declared permissions before installation. Electron supports a subset of Chrome APIs. Extension updates currently require a manual reinstall. See [extension compatibility](docs/extensions.md).
- Open **Agent** and choose **ChatGPT** or **Claude**. Relay uses the official Codex or Claude Code sign-in and opens the agent with browser access already configured. Ask it to move your tabs, change the interface, or manage browser settings. **Advanced settings** contains manual setup for other clients. See the [agent connection guide](docs/agent-connection.md).
- Use **Runtime customization** or your agent to apply custom CSS, replace the new tab page, hide built-in controls, add command buttons, and bind keyboard shortcuts. See the [runtime customization guide](docs/customization.md).

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
| `src/commands.cjs`, `src/customization.cjs` | Discoverable command schemas and persistent interface customization |

The browser controls run in a separate Electron session from webpages. Websites run in sandboxed views without Node.js or the browser controls’ preload. The agent API validates browser commands and keeps the control credential, OS access, and Chromium security settings outside its command surface.

## Contribute

Open an issue or pull request with the Windows version, Relay version, and steps to reproduce or verify the change. Keep browser controls, webpage contents, and agent permissions isolated when extending the app.

Licensed under [MIT](LICENSE).
