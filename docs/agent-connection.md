# Connect an agent to Relay Browser

Open the **Agent** button beside the window controls and enable the local connection. Connect an MCP client running on the same Windows account using Relay’s bundled stdio server. Install Node.js 22.12 or later and make `node.exe` available on your `PATH`. [Node.js downloads](https://nodejs.org/en/download)

The installer puts the server at `resources\agent\mcp.cjs` inside Relay’s installation folder. If you run Relay from source, use the absolute path to `src\agent\mcp.cjs` in your checkout. Keep `preferences.cjs` beside `mcp.cjs`.

## Claude Desktop and other local MCP clients

Use **Copy MCP config** in the Agent panel. In Claude Desktop, open **Settings → Developer → Edit Config**, then merge the `relay-browser` entry into the `mcpServers` object in `%APPDATA%\Claude\claude_desktop_config.json`. Restart Claude Desktop. [MCP guide for local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

The entry uses this format. Replace the paths with the locations on your machine.

```json
{
  "mcpServers": {
    "relay-browser": {
      "command": "node",
      "args": ["C:\\Path\\To\\Relay Browser\\resources\\agent\\mcp.cjs"],
      "env": {
        "RELAY_AGENT_FILE": "C:\\Users\\YourName\\AppData\\Roaming\\Relay Browser\\agent-connection.json"
      }
    }
  }
}
```

If your agent cannot find `node`, set `command` to its absolute path. To see the executable path in PowerShell, run `(Get-Command node.exe).Source`.

## Codex CLI

From PowerShell, register Relay as a local stdio server. Replace the script path with the absolute path shown in the copied MCP configuration. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```powershell
$relayAgentScript = 'C:\Path\To\Relay Browser\resources\agent\mcp.cjs'
codex mcp add relay-browser -- node $relayAgentScript
```

For a non-default Relay profile, add `--env "RELAY_AGENT_FILE=C:\Path\To\agent-connection.json"` before `--`. Start a new Codex session and confirm Relay appears in `codex mcp list`.

## Available tools

| Tool | Effect |
| --- | --- |
| `get_browser_preferences` | Read the current browser preferences. |
| `set_browser_preferences` | Apply the supplied preferences immediately and return the new values. |

| Preference | Accepted values |
| --- | --- |
| `tabPosition` | `top`, `left`, `right` |
| `theme` | `dark`, `light`, `system` |
| `homepage` | An HTTP or HTTPS URL without credentials, or `""` for Relay’s new tab page |
| `searchEngine` | `duckduckgo`, `google`, `bing` |
| `bookmarksBar` | `true`, `false` |

Try asking, “Move my tabs to the right and show the bookmarks bar.” The agent can call `set_browser_preferences` with `{"tabPosition":"right","bookmarksBar":true}`. Ask “Put my tabs back across the top” to reverse the layout change.

## Loopback HTTP API

Native local agents can use the bearer-authenticated preference endpoint directly. While the bridge is enabled, `%APPDATA%\Relay Browser\agent-connection.json` contains the current `endpoint` and `token`. Treat the file and token as credentials. Turning off the local connection revokes access and removes the file. Relay creates a fresh token whenever the bridge starts.

Use `GET` to read preferences and `PATCH` with `Content-Type: application/json` to update the fields above. The API returns a JSON object with a `preferences` field. It binds to `127.0.0.1` and accepts requests from local programs using the numeric endpoint as the `Host`.

```powershell
$relayConnection = Get-Content -Raw (Join-Path $env:APPDATA 'Relay Browser\agent-connection.json') | ConvertFrom-Json
$relayHeaders = @{ Authorization = "Bearer $($relayConnection.token)" }
Invoke-RestMethod -Uri $relayConnection.endpoint -Headers $relayHeaders -Method Patch `
  -ContentType 'application/json' -Body (@{ tabPosition = 'left' } | ConvertTo-Json -Compress)
```

The bridge is intended for agents you trust to change your preferences. Disabling it in the Agent panel disconnects all agents using it. The MCP server rereads the connection file on each tool call, so it picks up a new endpoint after you restart the browser or re-enable the connection.
