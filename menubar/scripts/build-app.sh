#!/bin/bash
set -euo pipefail

# Build OpenCodex Menubar.app via Tauri
# Usage: ./scripts/build-app.sh [--debug]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEBUG=false
if [[ "${1:-}" == "--debug" ]]; then
    DEBUG=true
fi

echo "==> Checking version sync..."
"$SCRIPT_DIR/check-version.sh"

echo "==> Installing frontend dependencies..."
cd "$PROJECT_DIR"
if command -v bun &>/dev/null; then
    bun install
else
    npm install
fi

echo "==> Building frontend..."
npx tsc -b && npx vite build

echo "==> Building Tauri app..."
# Source Cargo env before checking PATH (rustup installs may not be in non-interactive shells)
if [ -f "$HOME/.cargo/env" ]; then
    source "$HOME/.cargo/env"
fi

if ! command -v cargo &>/dev/null; then
    echo "ERROR: cargo not found. Install Rust via https://rustup.rs/"
    exit 1
fi

if $DEBUG; then
    cargo tauri build --debug
else
    cargo tauri build
fi

echo ""
echo "==> Done! App bundle at:"
if $DEBUG; then
    echo "    src-tauri/target/debug/bundle/macos/OpenCodex Menubar.app"
else
    echo "    src-tauri/target/release/bundle/macos/OpenCodex Menubar.app"
    echo "    src-tauri/target/release/bundle/dmg/OpenCodex Menubar_0.1.0_x64.dmg"
fi
