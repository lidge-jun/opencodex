# 007 — closeout

Terminal outcome: **DONE**.

## What landed

PR [#3286](https://github.com/lidge-jun/opencodex/pull/3286), squash-merged as `3d3c4fe26`
into `dev`. Ancestry proven:

```
git merge-base --is-ancestor 3d3c4fe26 FETCH_HEAD  ->  LANDED-ON-DEV
```

Five commits, one per work-phase plus the review fold:

| Commit | Phase | Content |
|---|---|---|
| `be0cda383` | wp0 | 11-doc roadmap unit |
| `b460299dc` | wp1 | Antigravity catalog, suffix ladder, suffix-tier rule, paragraph guard, constant rename |
| `bd2b03089` | wp2 | metadata source + regen, 5 price rows, reconcile preservation test |
| `a8c2314f3` | wp3 | direct Google, free-directory, sidecar default, Cursor seed, docs |
| `ea79ec132` | wp3 | maintainer-review fold: routed-generation guard, 3.7 `minimal` removal |

## Verification actually performed

- `bun run typecheck` — exit 0 at every phase boundary.
- Focused `bun test` only, never the repository-wide suite (maintainer instruction). Final
  focused set: 681 pass, 0 fail across 12 files.
- Full GitHub CI on the exact merged head `ea79ec132`: **25 success, 1 skipped, 0 failures**,
  including all four Linux test shards, macOS, Windows keyring, npm-global on three OSes,
  gates, storage policy, and `enforce-target`.
- Live CCA probes at three points: discovery shape, per-tier inference, and two adversarial
  probes that each disproved a plan assumption.

## What the process actually caught

Worth recording, because the interesting failures were all invisible from the diff:

| Round | Finding | How it was settled |
|---|---|---|
| A round 1 | 9 blockers, 2 High | folded; the two High ones were probe-confirmed |
| A round 2 | 5 more, 2 High — introduced BY the round-1 fixes | folded |
| A round 3 | PASS | — |
| Maintainer review on the pushed PR | retired ids reach the rejecting generation unguarded | reproduced at 429, fixed in `ea79ec132` |

The last one is the lesson. Three adversarial rounds against the plan missed it because it
lives in the interaction between two mechanisms that are each individually correct: retired
ids keep their own usage identity (protecting historical spend), and the paragraph guard keyed
on the selector. Neither is wrong. Their composition left every saved 3.6/3.5 config 429ing.

## Follow-ups

Recorded in `050`: the dead `ANTIGRAVITY_WIRE_MODELS` list, `gemini-3.5-flash`'s empty
modalities entry, OpenRouter's published `google/gemini-3.8-flash`, Vertex's frozen default,
and the `gemini-3.1-pro` suffix-tier asymmetry.
