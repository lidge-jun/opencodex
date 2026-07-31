# Phase 30 — Payload size guard + history trimming

## Problem
Gateway (payload_guards.py) trims oldest history pairs to fit a byte cap and
repairs orphaned tool results. opencodex kiro builds the full history with no
size guard; very long sessions can exceed Kiro's request limit and hard-fail.

## Plan (finalized in this phase's P)
- After buildKiroPayload, measure serialized byte size; if over cap, trim oldest
  history entries in user/assistant pairs, keeping >=2 entries and the current
  message intact.
- Preserve toolResult adjacency invariants the adapter already enforces (no
  orphaned toolResults after trim).
- Cap value: source from Kiro's documented/observed limit; make it a named const.

## Tests
- oversized history -> trimmed under cap, current message preserved.
- trim never orphans a toolResult (alternation invariant holds).
- under-cap payload -> untouched (byte-identical).

## Commit
feat(kiro): trim oldest history to fit payload byte cap (gateway parity)
