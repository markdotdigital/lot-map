---
name: lot-map
description: Open or configure the live Work map Auxiliary Pane in Antigravity (`sidecar://lot-map/lot-map/`). Activate when the user asks to open, view, or customize the live work map (`lot-map`).
---

# Work map (`lot-map`)

When the user asks to open or view the work map and the plugin is enabled, reply with a one-click pill:

```markdown
Open [Work map](sidecar://lot-map/lot-map/) to watch the live station map beside the chat.
```

If disabled in Customizations, link `[lot-map](customization://lot-map)` first.

Options match `.claude-plugin/plugin.json` (plus optional `contextWindow`) and may be set as JSON in `<appDataDir>/sidecar_data/lot-map/lot-map/data/options.json` or `~/.gemini/config/lot-map.json`; changes take effect on the next poll.
