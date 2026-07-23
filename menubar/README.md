# OpenCodex Menubar

macOS menubar widget for [opencodex](https://github.com/lidge-jun/opencodex) — glance at your proxy status without opening a browser.

## Features

- **Proxy status**: online/offline indicator, uptime, version
- **Request stats**: today's requests, tokens, estimated cost
- **Active combos**: current routing configuration at a glance
- **Provider quota**: visual quota bars (5h/weekly windows)
- **Quick actions**: switch combo, refresh quota, open dashboard

## Requirements

- macOS 10.15+
- [opencodex](https://github.com/lidge-jun/opencodex) running on `localhost:10100`
- Rust toolchain (`rustup`)
- Node.js 18+ (or Bun)

## Development

```bash
cd menubar
npm install
cargo install tauri-cli --locked   # one-time
cargo tauri dev                     # hot-reload dev mode
```

## Build

```bash
./scripts/build-app.sh             # release build → .app + .dmg
./scripts/build-app.sh --debug     # debug build (faster)
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `VITE_PROXY_URL` | `http://127.0.0.1:10100` | opencodex proxy URL |
| `VITE_API_TOKEN` | _(prompt)_ | API token for authenticated access |

## Architecture

```\+menubar/
├── src/                    # React frontend (thin shell over opencodex API)
│   ├── components/         # StatusBar, StatsRow, ComboList, QuotaBars, QuickActions
│   └── hooks/              # useProxyClient (polling + state)
├── src-tauri/              # Rust backend (tray icon + window management only)
│   └── src/main.rs         # Tray click → toggle popover, position near icon
├── scripts/                # build-app.sh, check-version.sh
└── tests/                  # Vitest unit tests
```

The widget is a **pure frontend client** — all data comes from opencodex's existing management API. The Rust layer only handles macOS system integration (NSStatusItem, NSPopover positioning, window lifecycle).

## License

MIT
