# 006 — maintainer review fold (PR #3286)

The maintainer review bot found a defect three audit rounds missed, and it was reproduced
against the live backend before being fixed.

## The finding: retired ids reach the rejecting generation unguarded

`rejectsClaudeSdkParagraph` keyed on the SELECTOR via `canonicalAntigravityUsageModel`. That
covers the collapsed base and the raw suffix rows, but not the third path into the same
generation:

```
gemini-3.6-flash  --rule 0-->  gemini-3.7-flash-tiered   (a rejecting generation)
```

Retired ids deliberately keep their OWN identity in `ANTIGRAVITY_USAGE_BASE_BY_ID` — that is
the rule protecting historical spend from being relabelled — so they can never canonicalize
into the generation they actually call. The two mechanisms were each correct and combined into
a hole.

Probe, 2026-09-03, live CCA:

```
resolveAntigravityEffortWireModel("gemini-3.6-flash")
  -> { wireModelId: "gemini-3.7-flash-tiered", thinkingLevel: "medium" }
saved 3.6 selection + Claude SDK paragraph -> 429 RESOURCE_EXHAUSTED
```

So every saved 3.6/3.5 config would have kept 429ing after this PR — the exact class of
silent breakage the retirement machinery exists to prevent.

**Fix:** judge on the ROUTED WIRE id, with the selector kept as a fallback. Naming a wire
spelling once now covers every selector that can reach that generation, instead of requiring
the set to enumerate selectors that redirect into it.

The test that asserted the old behavior (`preserves the paragraph for another Cloud Code
Assist model`, using 3.6) was asserting the bug. It is replaced by one proving the retired id
IS stripped, plus a real control on `claude-sonnet-4-6` — a model with no recorded rejection,
where the paragraph is literally true.

## Second finding: direct Google 3.7 advertises `minimal`

Recorded in `050` as a follow-up; the maintainer asked whether to fold it in. Folded, because
the evidence is identical to 3.8's (Google documents `minimal` as a validation error for that
generation) and the line was already being edited in this PR. Leaving it would ship a catalog
that offers a rung the API rejects, in the same file where the neighbouring row was just
corrected for the same reason. 3.5 and 3.6 keep theirs — their pages still list it, and this
unit has no evidence about them.

## Not folded

| Item | Disposition |
|---|---|
| `ANTIGRAVITY_WIRE_MODELS` dead list | Stays in `050`. Deleting an unrelated dead constant mid-rollout widens the diff for no behavioral gain. |
| `gemini-3.5-flash` empty `modelInputModalities` | Pre-existing, unrelated to this diff, and changing the DEFAULT model's advertised modalities deserves its own evidence. Added to `050`. |
| Cursor preemptive seed | Kept. The static catalog is intersected with the live roster, so the row stays invisible until Cursor lists it, and the `glm-5.3` precedent is explicit. |
