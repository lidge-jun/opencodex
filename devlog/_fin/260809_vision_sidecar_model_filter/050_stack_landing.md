# 050 — phase 5: land the stack on `dev`

No production code of its own. This phase takes the three published layers from
`040_stack_publication.md` and merges them into `dev`, bottom-up, one PABCD cycle
per layer. It also carries the automated-review debt that arrived after the stack
was opened.

## Authorization

The publication phase deliberately stopped at "PRs open, merging not authorized".
The user has since granted merge authority explicitly ("dev에 머지해"), so this
phase exists as a separate goal rather than an extension of the previous one. The
boundary is recorded here because the earlier goalplan states the opposite.

## Why bottom-up, one at a time

```
#1328  card  → base #1327 ──┐
#1327  api   → base #1326 ──┼── each retarget to dev happens only AFTER its parent lands
#1326  core  → base dev   ──┘
```

A stacked child shows its parent's commits in the diff until the parent lands.
Merging the parent and then retargeting the child to `dev` collapses the child's
diff to its own layer, which is what makes the second review meaningful. Merging
top-down, or retargeting before the parent lands, would push all three layers
through one review surface and defeat the split.

`enforce-target` skips the wrong-base gate for children of an OPEN parent. Once
the parent merges, the child must be retargeted to `dev` or the gate turns red —
so the retarget is part of the merge step, not a follow-up.

## Review debt (gate for this phase)

Eight inline findings landed on the stack after publication: five from the Codex
reviewer, three from CodeRabbit. They share one root cause worth naming, because
it decides whether they are separate bugs or one design defect:

> An option is emitted as a bare model **id**, and the provider identity that
> proved it eligible is discarded. Every consumer downstream then re-derives a
> provider — and each one re-derives it differently.

That single discard produces: baselines inserted with no provider to check
`noVisionModels` against (`eligibility.ts:127-131`), a non-selected
`adapter: "anthropic"` provider's unique ids offered but dispatched to the
selected OAuth endpoint (`eligibility.ts:100`), a bare-id early return that skips
the authoritative backend probe (`vision-sidecar-options.ts:82`), and a GUI that
drops the server-supplied `backend` and re-infers it from `/api/models`
(`dashboard-overview-sections.tsx:302`).

### Triage verdict (independent pass, current head `51bfc78`)

Seven of the eight are VALID against current code; five block the merge.

| Finding | Verdict | Layer |
|---|---|---|
| `eligibility.ts:64` consumer membership read from raw config, not registry-enriched | VALID — `enrichProviderFromRegistry` backfills `noVisionModels` that this predicate never sees, and the enriched catalog then force-adds `"image"` to exactly those rows | 1, blocking |
| `eligibility.ts:100` every `adapter: "anthropic"` provider is treated as the executor | VALID — dispatch uses only `findAnthropicVisionProvider` (first OAuth provider); a key-auth row like `umans` is offered but unreachable | 1, blocking |
| `eligibility.ts:131` baselines inserted with no eligibility check | VALID — a baseline listed in `noVisionModels` is still offered | 1, P2 |
| `eligibility.ts:78` bare-id collision claims native capability | VALID — a non-native row declaring `["text"]` is overridden by the native table | 1, P2 |
| `vision-sidecar-options.ts:82` first matching row short-circuits the backend probe | VALID — a custom `o3-mini` row declaring image lets a text-only model past the write gate | 2, blocking |
| `vision-sidecar-options.ts:45` non-executor anthropic rows suggested | VALID, but the same defect as `eligibility.ts:100` — one fix, not two | 2, blocking |
| `config-routes.ts:396`/`:501` grandfathers `gpt-5.4-mini` under an anthropic backend | VALID — runtime default is `claude-sonnet-5`; both response paths repeat it | 2, blocking |
| `dashboard-overview-sections.tsx:302` GUI re-infers the backend it was given | VALID — `visionModelOptions` maps `backend` away, then `sidecarBackendForModel` guesses `openai` | 3, blocking |
| CodeRabbit doc finding on 020/030 (no-executor fallback) | INVALID against the approved design — `020` explicitly specifies baselines as the catalog-outage floor, and the code implements that. Recorded, not actioned. | — |

Findings are triaged before any merge, per layer:

- A finding against layer N's own code is fixed on layer N's branch **before**
  that layer merges. Fixing it later means shipping a known defect into `dev` and
  reviewing the fix without the context that produced it.
- A finding that is INVALID against current code is closed with the concrete
  reason, not silently ignored.
- A finding whose fix would change the layer split (a new module, a schema
  change reaching all three layers) becomes an appended work-phase rather than a
  quiet in-place rewrite.

## Sequence per layer

1. Confirm `gh pr checks <n>` has no `fail` row on the CURRENT head. A cancelled
   shard is not a pass: rerun it and wait for the real verdict. Both #1326 and
   #1327 hit runner cancellations at 15m on the first pass, which reported as
   `fail` and had to be reruns rather than debugged.
2. Fold that layer's verified findings, push, and let CI settle again.
3. Merge into `dev`.
4. Retarget the child PR to `dev` and confirm its changed-file list shrank to its
   own layer.
5. Record the merge commit and the post-merge `dev` tip in the ledger.

## Rollback

Each layer is a separate merge commit on `dev`, so a bad layer reverts alone. The
GUI layer degrades to the legacy list against an older server, and the API layer
is inert without a caller, so a revert of layers 2-3 leaves the predicate in place
with no user-visible surface. Reverting layer 1 requires reverting all three.

## Acceptance

- Three PRs in state `MERGED` with `dev` as the final base.
- `origin/dev` contains the devlog unit, the predicate, the API guard, and the
  card restyle.
- `bun run typecheck` and `bun run test` green on the landed `dev` tip, run fresh
  rather than inherited from the last PR run.
- The unit moved to `devlog/_fin/` with the merge commits recorded.
