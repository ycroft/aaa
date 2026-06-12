# AAA · Agent Analyzer

Multi-backend desktop tool for analyzing local AI coding-agent session logs.
Built with Tauri 2 + React + TypeScript on the front end, and a small
tauri-free `aaa-core` crate on the back end.

## What it shows

- All sessions for the chosen backend: title (AI-generated when available),
  cwd, branch, time, message count, peak context window.
- Per-session timeline with collapsible nodes, distinguishing
  user input · assistant text · thinking · tool calls · tool results · system notes.
- Per-node token cost and a running cumulative-context indicator —
  with red highlight on the peak-context node and amber on sudden context jumps,
  so you can find where the window blew up.
- Dark / light themes, keyboard shortcuts, status-bar tooltips.

## Backends

| ID            | Status              | Default location                                        |
| ------------- | ------------------- | ------------------------------------------------------- |
| `claude-code` | Implemented         | `~/.claude/projects/`                                   |
| `opencode`    | Stub (coming soon)  | `${LOCAL_APPDATA}/opencode/` (overridable in settings)  |

Both can be pointed at any custom directory from the splash screen or settings.

## Architecture

```
tools/aaa/
├── core/                  # tauri-free model + provider impls (cargo workspace member)
│   └── src/
│       ├── model.rs
│       ├── providers/
│       │   ├── mod.rs
│       │   ├── claude_code.rs
│       │   └── opencode.rs
│       └── settings.rs
├── src-tauri/             # tauri host: commands + window
└── src/                   # React UI
    ├── App.tsx
    ├── components/
    └── styles/
```

The `SessionProvider` trait is the integration point for new backends —
return `SessionSummary` for listing and `SessionDetail` for opening.
The UI never speaks the native log format.

## Run

```bash
npm install
npx tauri dev          # development
npx tauri build        # release bundle
```

## Keyboard

| Shortcut         | Action                            |
| ---------------- | --------------------------------- |
| `Ctrl+,`         | Settings                          |
| `Ctrl+Shift+P`   | Switch backend                    |
| `Ctrl+F`         | Focus session filter              |
| `Ctrl+E`         | Toggle expand-all                 |
| `F5`             | Refresh sessions                  |
| `Esc`            | Close dialog                      |
