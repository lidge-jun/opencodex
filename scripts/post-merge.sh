#!/usr/bin/env sh
# Post-merge hook shim. The actual command lives in package.json ("postmerge").
# Installed by: bun run setup:hooks
#
# Never fails the merge: the merge already happened by the time this runs, so a
# non-zero exit here would only print a confusing error after a successful pull.
bun run postmerge || true
