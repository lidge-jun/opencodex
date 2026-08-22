# C-phase evidence — DeepSeek Responses streaming re-enable

Commit under test: `13c81cee5` + the `content_part` cross-table id-repair fix.

## Static gates

- `bun run typecheck` — clean (2026-08-07).
- Focused suites: `deepseek-inbound-wire` 24 pass, `deepseek-responses-item-id-repair`
  5 pass, `responses-item-id-repair` 5 pass. Full-suite run recorded below.

## Live activation (C-ACTIVATION-GROUNDING-01)

Isolated proxy: `OPENCODEX_HOME=$(mktemp -d)` seeded with only the deepseek
provider, `bun run src/cli/index.ts start --port 10199` from the patched tree.

1. **Streaming is live again** — 300-word essay probe through the patched proxy:
   `events=442 deltas=429 first_delta=0.53s terminal=5.85s done=True closed=5.85s`.
   First token in half a second; the bounded-JSON build would have delivered
   nothing until ~6 s (and 28-46 s on the turns in the original report).
2. **Terminal + sentinel** — the relayed stream ends `response.completed` then
   `data: [DONE]` (synthesized by the relay terminal boundary; upstream sends no
   sentinel per the official guide).
3. **#938 stays fixed on the streaming path** — tool-call probe: initial run
   leaked 13 raw UUID `item_id`s via `response.content_part.*` /
   `function_call_arguments.*` events (content parts wrap DeepSeek's streamed
   reasoning, and the static event-type map pointed at the message table only).
   Fixed with a cross-table fallback in `rewriteItemIdField`; re-probe:
   `BAD msg/rs UUID leaks: 0`, `function_call call_id preserved:
   call_00_wzzbHN9Bf0dVvM25aIhn3776` (function_call ids are intentionally
   untouched). Regression pinned in the streamed #938 test (content_part frame).

## Known pre-existing failure (not this unit)

`tests/jawcode-metadata-sync.test.ts` ("regenerating reproduces the committed
file byte for byte") fails identically on the parent commit `529646cd7` when the
jawcode source checkout is present (verified in a clean worktree with
`JAWCODE_MODELS_JSON` pointed at the sibling checkout; CI skips it without the
source). Generated-metadata drift predates this unit and is out of scope.
