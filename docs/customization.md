# Change Relay’s interface at runtime

Open **Browser menu → Runtime customization** to edit the interface yourself, or ask a connected agent to call `get_browser_customization` and `update_browser_customization`. Changes take effect immediately and are saved in your local browser profile. An update replaces only the fields you send.

| Field | What it changes |
| --- | --- |
| `css` | Styles the brand, tab strips, toolbar, bookmarks and find bars, new tab page, and regular panels. Use the browser’s own selectors and normal CSS rules. |
| `newTabHtml` | Replaces the default new tab page with your HTML and inline CSS. Supports passive markup and embedded raster images in an isolated frame. |
| `hiddenControls` | Hides built-in controls by name. |
| `buttons` | Adds buttons to the toolbar, new tab page, tab sidebar, or menu. Each button runs one browser command or a sequence. |
| `shortcuts` | Binds browser commands or sequences to key combinations such as `Ctrl+Shift+K`. |

The Agent button, Windows controls, and recovery panel are outside the custom styling area. Open **Agent → Restore default interface** to undo a customization even if the toolbar or menu is hidden. In fullscreen, press `F11` or `Escape` to return to the title bar. `Ctrl+Shift+U` opens the customization editor by default.

## Example

Use a purple address bar, a custom starting page, and one-click access to Wikipedia. Call `update_browser_customization` with these arguments.

```json
{
  "css": "#addressForm { border-color: rebeccapurple; border-radius: 18px; }",
  "newTabHtml": "<style>body { background: #1b1430; color: #eee6ff; }</style><h1>Research dashboard</h1><p>Open Wikipedia from the toolbar.</p>",
  "hiddenControls": ["home"],
  "buttons": [
    {
      "id": "open-wiki",
      "label": "Wikipedia",
      "location": "toolbar",
      "command": "newTab",
      "arguments": { "input": "https://www.wikipedia.org/" }
    }
  ],
  "shortcuts": [
    {
      "id": "wiki-shortcut",
      "accelerator": "Ctrl+Shift+K",
      "steps": [
        { "command": "newTab", "arguments": { "input": "https://www.wikipedia.org/" } },
        { "command": "zoom", "arguments": { "factor": 1.1 } }
      ]
    }
  ]
}
```

You can hide `address`, `back`, `forward`, `reload`, `home`, `bookmark`, `extensions`, `downloads`, `menu`, `bookmarksBar`, `topNewTab`, `sidebarNewTab`, `newTabShortcuts`, and `customizeShortcut`. Use `list_browser_commands` to discover the commands available to buttons, shortcuts, and agents. Use `set_browser_preferences` for the tab position, theme, homepage, search provider, and bookmarks bar preference.
