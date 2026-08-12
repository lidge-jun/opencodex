# 120 — Phase 13: reasoning-replay empty-delta handoff (PR #1126)

Credit: **NexusCore** (`@ZachDreamZ`,
`Agent59353 <email from PR head>`), PR #1126.
Adoption: **adapted** — the bug fix is taken, the persistence feature is not.

## Defect

Replay candidates are lost when a provider emits empty `text_delta` /
`thinking_delta` events, so reasoning replay restarts cannot reconstruct the
turn.

## Why adapted

A real empty-delta bug sits inside a much larger optional feature: persisting
chain-of-thought to disk, shutdown hooks, global counters, and config plumbing.
Writing model reasoning to disk is a privacy-surface change, not a bug fix —
`src/responses/reasoning-replay-cache.ts:17` documents a memory-only contract
deliberately. Changing that contract needs its own decision, not a ride along a
defect repair.

## Change

File list read from `gh pr diff 1126` against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `src/bridge.ts` | ADOPT (+14/−~4) | Preserve replay candidates across empty `text_delta`/`thinking_delta` events in the streaming and batch builders |
| `src/responses/reasoning-replay-cache.ts` | ADAPT (#1126: +244) | Take only the empty-delta handling. **Dropped:** disk persistence, exit hooks, and global warning counters — the memory-only contract at `:17` stays |
| `src/config.ts`, `src/lib/config-dir.ts`, `src/adapters/openai-chat.ts` | DROP | #1126 edits these only to plumb the persistence feature; none is needed for the defect |
| `tests/bridge-reasoning-replay-batch.test.ts` | ADOPT (NEW, +92) | Batch-builder empty-delta sequences |
| `tests/reasoning-replay-robustness.test.ts` | ADAPT (NEW, +240) | Streaming empty-delta sequences; drop the persistence cases and add an assertion that nothing is written to disk |

**Dropped:** disk persistence, exit hooks, global warning metrics, and the
associated config surface. Stated in the PR so the contributor can see exactly
what was kept and why.

## Verification

- `bun test` on the reasoning-replay and bridge suites
- `bun run typecheck`
- `bun run privacy:scan` (load-bearing here — it is the gate that would catch a
  reasoning-to-disk regression)

## PR

Stack 12, base = stack 11 head. Credits NexusCore. #950 is already closed by
#971, so no issue link.
