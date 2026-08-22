#!/usr/bin/env bun
// Compatibility stub for the pre-restructure entrypoint path.
//
// Before the src/ restructure the CLI lived at src/cli.ts, and durable launchers
// (codex shim wrappers, installed service definitions) baked that absolute path
// into their command lines. Users who upgrade in place with a bare
// `npm install -g @yansigit/opencodex` (instead of `ocx update`, which repairs the
// shim/service) would otherwise be stranded on a dead path. Keep this stub for at
// least one release cycle after the restructure ships.
import "./cli/index.ts";
