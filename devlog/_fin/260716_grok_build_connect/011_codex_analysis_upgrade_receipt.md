# 011 — codex analysis upgrade receipt

Date: 2026-07-16

## What was wrong
Initial pass only dropped thin (~280 total lines) notes under `180_grok-build-analysis/`. User correctly called out that the requested work was a real source-based upgrade of `~/Developer/codex` analysis docs, comparable to Claude/Codex analysis depth.

## What was done
1. Confirmed clone up to date: `/Users/jun/Developer/codex/180_grok-build` @ `b189869`.
2. Rewrote analysis set to 000–010 + ANALYSIS.md with crate/file citations:
   - inventory/architecture
   - install/`GROK_HOME`
   - auth
   - HTTP endpoints
   - sampling backends (chat/responses/messages)
   - custom models config
   - TUI/headless/ACP/WS surfaces
   - tools/MCP/plugins
   - third-party reuse
   - OpenCodex integration + live smoke
   - historical RE pointer
3. Mirrored docs into clone `180_grok-build/analysis/` for browse convenience.
4. Local commit on codex archive repo (no push).

## Paths
- `/Users/jun/Developer/codex/180_grok-build-analysis/ANALYSIS.md`
- `/Users/jun/Developer/codex/180_grok-build` (source clone)
