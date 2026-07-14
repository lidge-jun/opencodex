#!/usr/bin/env sh
# Pre-push hook: typecheck then test.
# Installed by: bun run setup:hooks
set -e
bun run typecheck
bun run test