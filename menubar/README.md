# OpenCodex Menubar

macOS menubar widget for [opencodex](https://github.com/lidge-jun/opencodex) — glance at your proxy status without opening a browser.

## Features

- **Usage**: 7-day token consumption, estimated cost, coverage ratio
- **Health**: provider status grid with enable/disable toggle
- **Status**: proxy uptime, version, stop action
- **Activity**: recent request log (model, provider, status, latency)
- **Auto-discovery**: reads proxy port from `~/.opencodex/runtime-port.json` — zero manual config

## Requirements

- macOS 10.15+
- [opencodex](https://github.com/lidge-jun/opencodex) running on `localhost:10100`
- Rust toolchain (`rustup`)
- Node.js 20+ (Vite 6 requires 20.19+)

## Development

```bash
cd menubar
npm install
npx tauri dev                       # hot-reload dev mode
```

## Build

```bash
./scripts/build-app.sh             # release build → .app + .dmg
./scripts/build-app.sh --debug     # debug build (faster)
```

## Architecture

```
menubar/
├── src/                    # React frontend (business logic)
│   ├── sections/           # Usage, Health, Status, Activity tabs
│   ├── hooks/              # usePolling (interval-based data refresh)
│   ├── api.ts              # Tauri IPC wrapper for management API
│   └── styles/             # Apple-style white theme CSS
├── src-tauri/              # Rust backend (thin OS layer)
│   └── src/
│       ├── tray.rs         # Tray icon + popover toggle + positioning
│       ├── keychain.rs     # macOS Keychain token storage
│       ├── discover.rs     # Auto-discover proxy URL/port/PID
│       └── api.rs          # Secure IPC proxy (token injection)
├── scripts/                # build-app.sh, check-version.sh
└── tests/                  # Vitest unit tests
```

The Rust layer is intentionally thin (~170 lines): tray lifecycle, window management, Keychain, and secure HTTP proxy. All business logic lives in TypeScript. API tokens never cross the IPC boundary to the WebView.

## License

MIT
