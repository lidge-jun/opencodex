#!/bin/bash
set -euo pipefail

# Ensure package.json and tauri.conf.json versions are in sync.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_VERSION=$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/package.json'))['version'])")
TAURI_VERSION=$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/src-tauri/tauri.conf.json'))['version'])")

if [ "$PKG_VERSION" != "$TAURI_VERSION" ]; then
    echo "ERROR: Version mismatch!"
    echo "  package.json:    $PKG_VERSION"
    echo "  tauri.conf.json: $TAURI_VERSION"
    exit 1
fi

echo "    Version $PKG_VERSION ✓"
