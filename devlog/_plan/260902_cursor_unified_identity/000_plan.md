# Cursor unified model identity

One published row per Cursor base. Thinking, fast, and 1M are dimensions of that row,
never extra slugs. The Codex Fast toggle drives the fast dimension; a global switch
exposes `-fast` identities to clients that have no toggle.

## Why

Cursor's own picker already works this way: `Claude Opus 5` is one row whose submenu
carries Thinking, Fast, Context (300K/1M), and Effort. OpenCodex has the same shape in
`CURSOR_CAPABILITIES` but never publishes it — `cursorUmbrellaRows()` is called by tests
only, and the picker is fed by the leftover product seed in `discovery.ts`.

## Constraints

- Every legacy id stays routable. Picker rows shrink; routability does not.
- Never run the repo-wide suite locally. Focused `bun test` files + `bun run typecheck`
  + `bun run privacy:scan`; exact-head GitHub CI is the authoritative gate.
- Stacked PR chain against `dev`, parent first. Pushes use `git push --no-verify`.
- Out of scope: Codex app UI, Cursor transport/native-exec, other providers' fast wires,
  dashboard `/api/models` namespaced ids, Desktop 3P hashed aliases.

## Work-phase map (dependency-ordered)

| WP | Deliverable | Consumes |
|----|-------------|----------|
| wp1 | this roadmap (docs only) | — |
| wp2 / PR1 | seed derives from the capability table; display names; window alignment | wp1 |
| wp3 / PR2 | `cursor-variant` FastWire; Codex Fast toggle reaches the fast dimension | wp2 (needs a stable base row set) |
| wp4 / PR3 | `fastMode` lists `-fast` identities outside Codex; request-time promotion | wp3 (needs the resolver's fast upgrade) |

wp3 depends on wp2 because the Fast toggle is stamped per row: the row set must be the
capability-derived one before a per-base capability map can be attached to it. wp4 depends
on wp3 because listing `<id>-fast` is only honest once the request path actually honours it.

## Measured current state (2026-09-02, `.tmp/cursor_diff_probe.ts`)

```
SEED_COUNT 54          # CURSOR_STATIC_MODELS
CAPS_COUNT 34          # CURSOR_CAPABILITIES
UMBRELLA_ROWS 34       # cursorUmbrellaRows() — none missing from the seed
ROWS_NOT_IN_SEED []    # capability rows are all seeded
CAPS_NOT_IN_SEED []
SEED_NOT_IN_CAPS (16)  # claude-4-sonnet-1m, claude-4.5-haiku, composer-1, composer-2.5,
                       # composer-2.5-fast, gemini-2.5-flash, gemini-3-flash, gemini-3-pro,
                       # gemini-3-pro-image-preview, gemini-3.1-pro, gemini-3.5-flash,
                       # gpt-5-codex, gpt-5-fast, gpt-5-mini, gpt-5.1-codex, kimi-k2.7-code
WINDOW_MISMATCH        # gemini-3.6-flash 1048576/1000000, gemini-3.7-flash 1048576/1000000,
                       # gpt-5.5-extra 200000/272000
FAST_CAPABLE_BASES     # claude-opus-4-7, claude-opus-4-8, claude-opus-5, grok-4.5, grok-4.6
```

54 = 4 routers + 34 capability bases + 16 non-capability product ids.

## Verifiers (RUN 2026-09-02 before being written here, PLAN-VERIFIER-REAL-01)

| Command | Exit | Reads the change target? |
|---|---|---|
| `bun test tests/cursor-umbrella-rows.test.ts tests/cursor-catalog.test.ts tests/cursor-static-catalog.test.ts` | **1 — 74 pass / 1 fail** | yes — imports `catalog.ts` + `discovery.ts` directly |
| `bun test tests/fastwire-policy.test.ts tests/fastwire-observability.test.ts tests/service-tier-capability.test.ts` | 0 — 303 pass | yes — imports `fastwire.ts` / `service-tier.ts` |
| `bun test tests/claude-model-info.test.ts tests/claude-models-discovery.test.ts` | 0 — 27 pass | yes — imports `claude/model-info.ts` |
| `bun run typecheck` | pending measurement at wp2 B | yes — `tsc --noEmit` over `src/` and `tests/` |
| `bun run privacy:scan` | pending measurement at wp2 B | repo-wide credential scan; **does not observe this unit's behavior** |

`privacy:scan` is a required gate, not a verifier of identity behavior; that acceptance row
is human review plus the focused tests above.

**Pre-existing red on this branch point.** The cursor suite fails at HEAD `d975feaa4`,
before any change in this unit:

```
(fail) row count shrank from the 69-row legacy seed
  tests/cursor-umbrella-rows.test.ts:40   Expected: 51   Received: 54
```

Commit `5fc7d073e` seeded three `claude-fable-5-1` spellings and did not update the
assertion. wp2 owns the fix (010 §4 rewrites that assertion to the derived composition),
so wp2's C-phase evidence must show this file green rather than inheriting the failure.

Environment note: a fresh worktree needs `bun install` first — without it these files fail
with `Cannot find module 'zod/v4'` / `'@bufbuild/protobuf'`, which is not a code defect.

## Terminal outcomes

DONE = wp1-wp4 closed through D with three stacked PRs at exact-head green CI.
BLOCKED = CI infrastructure or a live Cursor roster change with evidence.
NEEDS_HUMAN = a user-visible identity fork beyond the stated intent.
BUDGET_EXHAUSTED = 6h wall-clock or three failed repair rounds on one WP.
