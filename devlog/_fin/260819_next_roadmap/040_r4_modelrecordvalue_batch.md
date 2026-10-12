# 040 — R4: the `modelRecordValue` family, reviewed as one batch

Work-phase: wp4. Scope: **review only. No merges.**

## Why one batch and not four reviews

`#2077`, `#2085`, `#2086`, `#2100` are the same one-line idea applied at four
call sites. Reviewing them separately spends four independent judgments on a
contract that only has to be decided once.

## The shared contract

**Corrected 2026-08-19 after a review lane refuted the first version.** The
contract as originally written implied every per-model map should migrate to
`modelRecordValue`. That is false, and acting on it would have shipped two
regressions.

`modelRecordValue` (`src/reasoning-effort.ts:73`) resolves in this order:

1. exact model id, **own property only**;
2. if the id contains `:` past the first character, the **case-sensitive**
   pre-colon family, own property only;
3. a case-insensitive match on the **full** id across own entries;
4. otherwise `undefined`.

Two subtleties the first draft missed: there is no case-insensitive *family*
match, and a case-sensitive family key beats a differently-cased full-id key.

The contract, restated correctly: **code that reports, gates, or describes what
the runtime will do with a per-model override must use the same resolution the
runtime uses for that map** — which is not `modelRecordValue` for every map.

Two maps are deliberately exact-own-only:

| Map | Runtime reader |
|---|---|
| `modelPreferHostedTools` | `src/adapters/openai-responses.ts:989` (exact, own-property) |
| `modelOpenRouterRouting` | `src/providers/openrouter-routing.ts:83` (exact, own-property) |

For those, a bare `map?.[modelId]` is still wrong — it walks the prototype
chain — but `modelRecordValue` is *also* wrong, because it adds family and
case-folded inheritance the adapter will not honor. The right primitive there
is an exact own-property lookup, not either of the two.

So the family-aware migration is correct for nine maps and a regression for
two. "Read it the way the runtime reads it" is the invariant; "use
`modelRecordValue`" is only its implementation for the family-aware set.

## Why the failure mode is worse than "missing an entry"

In `#2085` and `#2100` the bare lookup does not degrade to unknown; it **falls
through to the provider-wide value**. That is a definite wrong answer rather
than an absent one. `#2085`'s case: `modelContextWindows: {"gpt-oss": 131072}`
with a request for `gpt-oss:120b` resolved nothing, fell back to
`contextWindow: 8000`, and the admission gate refused turns the model can
plainly hold.

`#2077` carries a second, sharper defect worth calling out separately: the bare
index **walks the prototype chain**. A routed model id of `constructor` or
`toString` returns an `Object.prototype` function, which makes
`buildBehaviorFingerprintV1` throw "unsupported value type function". That
throw is swallowed by `resolvePassiveRouteSubjectId`, so the subject is
silently dropped — inside a linker whose contract says implementations do not
throw. `openai-responses.ts` already guards `modelPreferHostedTools` for
exactly this reason.

## Per-PR verdicts

| PR | Site | Verdict |
|---|---|---|
| #2085 | admission input ceiling | **merge** |
| #2086 | `ocx models` CLI | **merge** (draft; ready on content) |
| #2100 | routing capability evidence | **hold** — incomplete migration |
| #2077 | Lab behavior fingerprint | **hold** — over-broad migration |

No two touch the same file or function, so there is no textual conflict; the
order is about correctness, not merge mechanics.

### #2085 — merge

The "definite wrong answer" claim is verified: a missed `modelContextWindows`
lookup falls through to the provider-wide `contextWindow`
(`src/server/responses/input-admission.ts:136`), so the admission gate refuses
turns the model can hold. Both per-model reads in the file are migrated.

### #2086 — merge

The ordering claim checks out against `src/vision/index.ts:29`:
`isModelTextOnly` returns true on the `noVisionModels` match before it reads
the modality map, and the PR mirrors that order. It also correctly upgrades
`.includes(model)` to `modelInList`. The description is stale (says two tests,
adds three).

### #2100 — hold

The six map reads are migrated correctly, but the **`noVisionModels`
precedence is missing**. With `noVisionModels: ["gpt-oss"]` and
`modelInputModalities: {"gpt-oss:120b": ["text","image"]}`, the runtime says
text-only while `candidateCapabilityEvidence` reports `image: true`. Routing
acts on this evidence, so it can select a candidate for image work that
execution then rejects — the exact ordering bug #2086 fixes on the CLI surface,
left unfixed on the routing surface.

Needs: the no-vision check before modality derivation, plus a regression for
the conflicting-evidence case. Also `contextWindow.not.toBe(8_000)` is a weak
assertion — it accepts `undefined` and any other wrong value.

### #2077 — hold

The prototype-chain defect is real and the fix is right for the nine
family-aware maps. But `modelValue` is **also** used for
`modelPreferHostedTools` (`src/routing/compatibility/behavior.ts:186`), so the
PR makes a `gpt-oss` family entry affect `gpt-oss:120b` in the behavior
fingerprint even though the adapter will not apply it. That violates the
contract it is trying to enforce. `modelOpenRouterRouting` at `behavior.ts:71`
is still a bare read and was missed.

Needs: `modelRecordValue` for the nine family-aware maps, and a separate
exact-own helper for hosted tools and OpenRouter routing.

One correction to the PR's own narrative, worth passing to the author: the
throw is caught at `src/routing/compatibility/subject.ts:125`, not by
`resolvePassiveRouteSubjectId`. The silent-subject-drop conclusion holds; the
described control flow does not.

## Recommended order

1. `#2085`
2. `#2086` (may swap with #2085)
3. `#2100` after no-vision precedence lands
4. `#2077` after exact-own semantics are preserved

## Exit criteria

- `c-mrv`: one shared contract verdict plus four per-PR verdicts, each from a
  read of the actual diff. **Met** — and the contract itself was corrected by
  the review rather than merely confirmed.
- No merges.
