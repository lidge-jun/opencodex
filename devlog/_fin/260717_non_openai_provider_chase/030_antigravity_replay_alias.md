# WP3 — Antigravity replay and picker/alias separation

## Goal and dependency

Track replay state per content-block index and decide picker retirement independently from inbound alias compatibility.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/adapters/google-antigravity-replay.ts` | replay/signature sanitation assumes current sequential content shape | normalize and reconcile replay entries by stable role/content/index with bounded cache semantics |
| MODIFY | `src/adapters/google.ts` | replay application has no explicit malformed/interleaved activation proof | pass canonical indexed content state and surface safe diagnostics for invalid signature placement |
| MODIFY | `src/providers/antigravity-models.ts` | `gemini-3.1-pro-high` is both picker row and wire alias | retain resolver alias unconditionally; expose picker row only when the authenticated availability policy says it is current |
| MODIFY | `tests/google-antigravity-replay.test.ts` | sequential replay fixtures | add interleaved/indexed signature, stale-cache, malformed signature, and bounded-session fixtures |
| MODIFY | `tests/google-antigravity-wire.test.ts` | alias and picker expectations are coupled | prove a hidden picker alias still resolves saved inbound configuration to `gemini-pro-agent` |
| MODIFY | `tests/google-models-listing.test.ts` | no retirement probe fixture | assert authenticated listing result controls exposure without deleting inbound compatibility |

## Activation scenarios

- Two interleaved thought/tool blocks replay the correct signature into their matching content blocks.
- Invalid signatures are removed only from the affected block and emit no token/body contents in diagnostics.
- An authenticated model listing that omits `gemini-3.1-pro-high` hides the picker row; a direct saved selector still maps to `gemini-pro-agent`.
- A listing failure preserves the conservative static fallback and does not turn a network error into deprecation.

## Verification

```bash
bun test tests/google-antigravity-replay.test.ts tests/google-antigravity-wire.test.ts tests/google-models-listing.test.ts
bun run typecheck
```

Authenticated availability/inference proof is required before changing picker exposure.

## Terminal outcomes

- `DONE`: indexed replay fixtures pass and live evidence supports the picker decision while alias compatibility remains.
- `NOOP`: current replay structure cannot reproduce loss and the picker remains live; retain fixtures/evidence only.
- `NEEDS_HUMAN`: no Antigravity account is available for availability proof.
- `UNSAFE`: change would delete a saved-config alias without migration.
