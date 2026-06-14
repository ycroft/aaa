# AAA · Agent Analyzer

Multi-backend desktop tool for analyzing local AI coding-agent session logs.
Built with Tauri 2 + React 18 + TypeScript on the front end, a tauri-free
`aaa-core` crate that owns the data model and providers, and an optional
`aaa-hub` server (Rust / Axum / SQLite) for auto-update + feedback.

See [`CLAUDE.md`](CLAUDE.md) for the engineering notes that ship with the
repo (project structure, extension points, build & distribution).

## What it shows

- All sessions for the chosen backend: title (AI-generated when available),
  cwd, git branch, time, message count, peak context-window tokens.
- Per-session timeline with collapsible nodes — user input · assistant text ·
  thinking · tool calls · tool results · attachments · system notes — and a
  separate roll-up for sub-agent / sidechain sessions when the backend
  exposes them (claude-code).
- Per-node token cost and a running cumulative-context indicator with a red
  highlight on the peak-context node and amber on sudden context jumps, so
  you can find where the window blew up.
- In-session message search (`Ctrl+F`): full-text match across text /
  thinking / notes / tool input/output / attachment paths, with cycle-through
  on repeated activations and auto-expand + scroll to the hit.
- Skill-usage report for `claude-code` sessions (counts and error counts per
  skill id; the same data backs phase-2 heuristic detection for other
  backends — see `core/src/stats.rs`).
- Optional AI-assisted analysis: launches a configured local agent
  (Claude Code / opencode / custom) in a new terminal with a prompt template
  and the exported session JSON.
- Remote sessions over SSH: register hosts in settings, sync the provider
  root into a local cache (resumable, progress-reported, cancelable), then
  open the cache directly when offline.
- Session export to pretty JSON, single-session or whole-root.
- Optional `aaa-hub` integration: auto-update via `tauri-plugin-updater`,
  in-app feedback dialog with redacting log excerpt + screenshot
  attachments, and a "My feedback" list backed by anonymous claim tokens.
- Light / dark / Windows 98 retro themes; menubar, toolbar, status-bar
  tooltips and keyboard shortcuts throughout.

## Backends

| ID            | Status      | Default location                                                                  |
| ------------- | ----------- | --------------------------------------------------------------------------------- |
| `claude-code` | Implemented | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (line-delimited JSONL)       |
| `opencode`    | Implemented | `~/.local/share/opencode/opencode.db` (SQLite — overridable to a dir or db file)  |

Both can be pointed at any custom directory from the splash screen or
settings. Remote roots (over SSH) are configured per-host in the Settings
dialog and synced to a local cache before reading.

## Architecture

```
tools/aaa/
├── core/                  # tauri-free model + providers + remote sync (cargo workspace member)
│   └── src/
│       ├── model.rs              # SessionSummary / SessionNode / MessagePart / TokenUsage
│       ├── providers/
│       │   ├── mod.rs            # SessionProvider trait + registry
│       │   ├── claude_code.rs
│       │   └── opencode.rs
│       ├── remote/               # SSH + known-hosts + mirror sync
│       ├── feedback.rs           # local ticket store
│       ├── log_buffer.rs         # in-process WARN+ERROR ring (200 entries)
│       ├── log_excerpt.rs        # redacting log excerpt for feedback
│       ├── logger.rs             # file logger init
│       ├── settings.rs           # AppSettings persistence (~/.config/aaa/settings.json)
│       └── stats.rs              # skill-usage roll-up
├── src-tauri/             # tauri host
│   └── src/
│       ├── commands.rs           # session / settings / remote / export commands
│       ├── hub.rs                # HubClient (auto-update + feedback)
│       ├── hub_commands.rs       # 6 hub-related commands (silent on failure)
│       └── lib.rs                # Tauri builder + plugin wiring
├── src/                   # React UI
│   ├── App.tsx                   # top-level state machine
│   ├── api.ts                    # @tauri-apps/api::invoke wrappers
│   ├── components/               # Menubar / Toolbar / SessionList / SessionViewer / …
│   ├── hooks/                    # useStatusHint
│   ├── types.ts                  # TS mirror of core::model
│   └── styles/
├── server/                # aaa-hub server (Rust / Axum / SQLite, single binary)
├── docs/                  # design + implementation notes for hub
├── scripts/               # dev / build-release / install / package-portable (Linux + Windows)
└── vendor/                # vendored upstream artifacts so AppImage / MSI / NSIS build offline
```

`SessionProvider` (in `core/src/providers/mod.rs`) is the integration point
for new backends — return `SessionSummary` for listing and `SessionDetail`
for opening, optionally declare default remote roots and the file subset to
sync. The UI never speaks the native log format.

## Run

```bash
npm install

# Dev (Vite HMR + cargo incremental + auto-open):
./scripts/dev.sh                 # Linux / macOS
./scripts/dev.cmd                # Windows

# Release bundles:
./scripts/build-release.sh       # Linux  → deb / rpm / AppImage / bare binary
./scripts/build-release.ps1      # Windows → MSI / NSIS / bare aaa.exe
```

Node ≥ 20.19 (Vite 8 requires it). See `CLAUDE.md` for system prerequisites,
install scripts (`install-linux.sh` / `install-windows.ps1`), portable
tarball / zip packaging, and the offline-build vendor cache layout.

## Keyboard

| Shortcut         | Action                                              |
| ---------------- | --------------------------------------------------- |
| `Ctrl+,`         | Open settings                                       |
| `Ctrl+Shift+P`   | Open data source (provider splash)                  |
| `Ctrl+F`         | Focus in-session message search                     |
| `Ctrl+Alt+F`     | Focus the session-list filter                       |
| `Ctrl+E`         | Toggle expand-all for the timeline                  |
| `Ctrl+Shift+E`   | Export current session as JSON                      |
| `F5`             | Refresh sessions                                    |
| `Esc`            | Close the topmost dialog                            |
