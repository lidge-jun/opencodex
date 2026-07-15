#!/usr/bin/env sh
# Pre-push hook shim. The actual command list lives in package.json ("prepush").
# Installed by: bun run setup:hooks
set -e
exec bun run prepush
