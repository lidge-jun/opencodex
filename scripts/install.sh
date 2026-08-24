#!/bin/bash
set -euo pipefail

echo "Installing opencodex..."

if ! command -v node &>/dev/null; then
  echo "Node.js 22+ is required. Install Node from https://nodejs.org/ and rerun this script." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required. Current version: $(node --version)" >&2
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "npm is required to install the published opencodex package." >&2
  exit 1
fi

echo "Using Node $(node --version)"

# Install opencodex globally
# If npm reports "install scripts blocked" for bun, rerun as:
#   npm install -g --allow-scripts=bun @yansigit/opencodex
# (keep sudo if the original install used sudo)
npm install -g @yansigit/opencodex

if ! command -v ocx &>/dev/null; then
  NPM_BIN="$(npm bin -g 2>/dev/null || printf "%s/bin" "$(npm prefix -g)")"
  echo "opencodex installed, but 'ocx' is not on PATH." >&2
  echo "Add your npm global bin directory to PATH, then rerun your shell: $NPM_BIN" >&2
  exit 1
fi

if ! ocx help >/dev/null; then
  echo "opencodex installed, but 'ocx help' failed. Check your npm global install and PATH." >&2
  exit 1
fi

echo ""
echo "✅ opencodex installed! Run 'ocx init' to set up."
