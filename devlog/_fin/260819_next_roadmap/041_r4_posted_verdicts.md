# 041 — R4 verdicts as posted

| PR | Verdict | Comment |
|---|---|---|
| #2085 | merge | [5340681951](https://github.com/lidge-jun/opencodex/pull/2085#issuecomment-5340681951) |
| #2086 | merge (draft) | [5340682189](https://github.com/lidge-jun/opencodex/pull/2086#issuecomment-5340682189) |
| #2100 | hold | [5340682460](https://github.com/lidge-jun/opencodex/pull/2100#issuecomment-5340682460) |
| #2077 | hold | [5340682748](https://github.com/lidge-jun/opencodex/pull/2077#issuecomment-5340682748) |

Each comment says it was reviewed as part of a four-PR batch, so an author
seeing a hold knows it came from a comparison rather than a one-off objection.

## What each author was asked for

**#2100** — check `noVisionModels` before deriving modalities, plus a
regression for the conflicting-evidence case. The framing matters: this is a
gap in the PR's own terms, since its stated goal is that the evidence agree
with the resolver it describes. Also flagged `contextWindow.not.toBe(8_000)`
as a weak assertion that accepts `undefined`.

**#2077** — split the migration: `modelRecordValue` for the nine family-aware
maps, an exact-own helper for `modelPreferHostedTools` and
`modelOpenRouterRouting`. The PR currently makes a family entry affect the
behavior fingerprint for a map the adapter reads exactly — the same divergence
it set out to remove, pointed the other way. Also corrected the description's
control flow (the throw is caught at `subject.ts:125`, not by
`resolvePassiveRouteSubjectId`), since that text would otherwise land in the
commit message.

**#2085 / #2086** — merge verdicts, with one note each that is not a change
request: #2085's direct `modelRecordValue(...)` assertions are ground truth
rather than coverage, and #2086's description undercounts its own tests.

## Why the batch was worth it

The shared contract had to be corrected before any verdict was safe. As first
written it implied every per-model map should move to `modelRecordValue`. Two
maps are deliberately exact-own-only, so that migration is a regression for
them — and #2077 performs exactly that migration. Reviewed one at a time,
#2077 reads as a correct one-line fix with a good test.
