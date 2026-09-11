# 030 — wp4: closure

1. Cleanliness comparison table: rows before/after (69 -> ~34), effort-map
  229 LOC deleted vs catalog.ts added, single-module truth vs senpi's
  3-surface split (static TS + 336-row JSON + regex) vs omo's absent map;
  thinking merged for ALL families (senpi: Claude split remains); fast as
  dimension (senpi: separate groups).
2. Picker proof: opencodex-catalog.json cursor section before/after row
  counts + one umbrella row excerpt showing efforts incl ultra.
3. Back-compat proof: legacy-id wire table test green (every 69 id routes
  to the same wire id as before, or documented intentional change).
4. Stack finalization: PR A -> dev, PR B stacked; retarget checks.

## Closure results (2026-08-28)

### Cleanliness comparison

| Measure | Before (opencodex) | After | senpi | omo-ai@beta |
|---|---|---|---|---|
| Picker rows (cursor, non-router) | 65 | 47 seed rows / 31 umbrella identities | ~raw roster + grouped-with-fast-splits | none (no cursor map at all) |
| Variant duplicate rows | 22 (13 thinking + 7 fast + 2 x 1m) | 1 (claude-4-sonnet-1m real wire id) + composer-2.5-fast (no effort base) | thinking split retained for Claude; fast groups separate | n/a |
| Capability truth surfaces | 2 (effort-map tables + discovery seed annotations) | 1 (catalog.ts CURSOR_CAPABILITIES) | 3 (static TS table + 336-row generated alias JSON + display-name regexes) | 0 |
| Thinking handling | 13 separate picker rows | dimension; merged into base for ALL families | Claude-only thinkingMode split | delegated |
| Fast handling | 7 separate rows | dimension; aliases only | separate catalog groups; parameter fast always "false" | delegated |
| 1M/Max-Mode | single synthetic kimi-k3-1m row | window metadata generalized (claude/gemini/kimi/gpt-5.6 1M) + evidence-gated ultra->maxMode (static kimi-k3 + live maxModeModels union) | window/maxWindow fields; maxMode from name regex + family pattern (window-size inference we rejected as unsupported) | delegated |
| Back-compat | n/a | every legacy slug byte-identical (oracle + pinned-session tests) | variant-id fallback silently degrades to representative id | n/a |

LOC: effort-map.ts (229) still present as the test oracle only — zero src/
consumers remain (request-builder/discovery now import catalog.ts; discovery
keeps two legacy helpers for the transition). catalog.ts is 541 lines
INCLUDING the full capability table that previously lived across two files
plus prose. Deletion of effort-map.ts is queued for the post-merge cleanup
once the oracle freezes to literal fixtures.

### Picker proof

cursorUmbrellaRows(): 31 identities. Excerpt: kimi-k3 {efforts:[low,high,max],
window:1000000, maxModeVerified:true} — the old kimi-k3-1m row is gone and its
capability rides the base. Seed: 51 rows (4 router + 47).

### Stack

| PR | base | head | state |
|---|---|---|---|
| #2801 core | dev | codex/cursor-umbrella-core 54965ef03 | open |
| #2802 wire | codex/cursor-umbrella-core | codex/cursor-umbrella-wire 075c5705a | open, retarget to dev after #2801 |

Verification totals: 1137 tests / 56 cursor+catalog files pass on the wire
head; tsc 0; privacy scan pass. CI is the wide gate per user instruction.
