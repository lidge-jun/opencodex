# 040 — Delivery record

Terminal outcome: **DONE**. All three gaps closed on `origin/dev` via PR #3478,
merged as `3a9c4d297` and ancestry-proven.

| Gap | Closed as | Evidence on `dev` |
|-----|-----------|-------------------|
| PR #3293 fable-5-1 metadata | `3a9c4d297` | `claude-fable-5-1` present in the source json and the generated `anthropic` row |
| Issue #3431 CREDITS for #3284 | `3a9c4d297` | `CREDITS.md` carries the row quoting @Ingwannu verbatim |
| Issue #3429 Ultra Fast | `3a9c4d297` | `ultraFastTier` in config, types, and the routed normalizer |

## The review round is the part worth keeping

The first implementation passed every suite and was wrong.

Recognising `ultrafast` as a canonical marker routed it into `decideTier`'s
`canonicalToWire` lookup, which maps only `priority`. An unmapped canonical fell
through to `{ kind: "drop" }`, so the tier stopped reaching the provider —
where previously, as a *foreign* tier, `foreignCallerTiers: "verbatim"` had
forwarded it untouched. Recognition made the reported problem worse:

```text
before   ultrafast -> forward-caller   wire service_tier=ultrafast
after    ultrafast -> drop             wire service_tier=(absent)
```

Every listed suite stayed green because they unit-tested
`canonicalFastTierMarker` and `requestLogSpeedLabel` in isolation and never
asserted the wire decision. The byte golden could not catch it either: it pins
*catalog* bytes, not the caller routing path.

Two lessons, both cheap to state and expensive to relearn:

- A test that exercises the two functions you edited is not a test of the
  behavior you changed. The gap was one call frame away.
- Widening a predicate is not free. `callerCanonicalFast` served three different
  questions — drop, suppression, and intent — and widening it for the third
  silently changed the first two, which is how `callerFastSuppressedByConfig`
  came to claim the Fast toggle had suppressed a tier that is not Fast.

## What was deliberately NOT done

Ultra Fast is still absent from the model picker. `upstream-models.json`
advertises only `priority`, so a catalog row would offer a speed the wire cannot
deliver — the exact defect PR #2994 was closed for. The opt-in preserves a tier
the operator supplies and names it honestly in the logs; it invents nothing.

If upstream ever advertises the tier, items 1 and 2 of #3429 become implementable
and this note is where to start.

## Where the pieces live

- `src/providers/fastwire.ts` — `canonicalFastTierMarker` folds `ultrafast`;
  `decideTier` falls through to the foreign-tier rules for an unmapped canonical;
  `callerCanonicalFast` stays `=== "priority"` for the drop/suppression facts.
- `src/codex/catalog/parsing.ts` — `retainOnlyUltraFastTier` and the memoized
  `ultraFastTierOptIn`.
- `src/server/request-log.ts` — the `ultrafast` speed label.
- `gui/src/components/UltraFastTierSetting.tsx` and
  `codex-account-pool-main-card.tsx` — the toggle and the relocated action row.
- `tests/ultrafast-tier-honesty.test.ts` — 15 tests, including the five added
  after the review that assert the wire decision the original suite missed.

## Loop close

Four work-phases: the docs-only roadmap, then the three gap closures, all landed
through one pull request because they were small, independently reviewable, and
shared a review round. `cxc loop validate` passes with every criterion carrying
captured evidence.
