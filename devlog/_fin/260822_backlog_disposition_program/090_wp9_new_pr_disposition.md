# 090 — WP9: disposition of the four PRs that arrived mid-loop

#2361, #2362, #2363, #2364 all arrived from one contributor while work-phase 0 was
running, and all four claim to close an issue. Four independent read-only review lanes
were dispatched (`xai/grok-4.6`, high reasoning effort, after the
`openrouter/stealth-ox-alpha` lanes hit provider 429s and were retired).

## Verdicts

| PR | Claims | Verdict | Disposition |
|----|--------|---------|-------------|
| #2361 | Closes #2356 | GO-WITH-FIXES (blockers=0) | **MERGE** |
| #2362 | Closes #1809 | reviewer lane failed to return; **reviewed directly** | **LEAVE OPEN**, blockers restated |
| #2363 | Closes #1225 | **FAIL** | **LEAVE OPEN**, blockers restated |
| #2364 | Closes #1406 | **FAIL** | **LEAVE OPEN**, blockers restated |

## #2361 — merge

The only one that does what its issue asked. The reviewer confirmed the maintainer's
three requirements: the sentinel is converted inside `mapReasoningEffort`, openai-chat's
existing `undefined` branch does the omitting, and **no default omission was baked into
the ollama registry entry** — which the triage explicitly forbade.

Load-bearing proof, run in the reviewer's own throwaway worktree: reverting
`src/reasoning-effort.ts` to the merge base makes the new test fail with
`expected undefined, received "__omit__"`. The test is real.

Three non-blocking findings accepted as-is: the sentinel is undocumented in
`src/types/provider.ts` and docs-site (Medium, discoverability), a dead post-clamp
sentinel check that can never fire, and an unused exported helper
`isReasoningEffortOmitted`. None changes behavior.

This also supersedes **#2357**, the wrong-base draft against `main` for the same issue.
#2357 closes rather than retargets — the branch policy forbids feature PRs against
`main`, and a maintainer rewriting a contributor's PR base is worse than asking them to
reopen.

## #2363 — FAIL, and the proof is the interesting part

The reviewer deleted the **real call site** in `writeRetainedCatalogSync` and re-ran the
PR's own tests:

```
(pass) applyAutoReviewModelOverride sets auto_review_model_override across all entries
(pass) applyAutoReviewModelOverride is a no-op when autoReviewModel is null or empty
  2 pass, 0 fail
```

The tests pass with the feature disconnected. They exercise the exported mutator, never
the write path — so CI would stay green while catalog sync emits `null` again.

Two more blockers stand independently:

- **The dashboard writer never stamps.** `prepareCatalog` / `convergeCodexCatalog`
  (`src/codex/convergence.ts:367`) rebuilds routed rows from templates with
  `auto_review_model_override: null`. The GUI path undoes what `ocx sync` just wrote,
  which is the original #1225 failure mode returning through the primary surface.
- **No slug validation.** Issue #1225 requires validating the target against the same
  sync's catalog and failing clearly on an unresolved target. A stale slug is stamped
  silently, and fail-closed auto-review then denies every approval.

Also: native rows are overwritten without the opt-in the issue asked for, and docs are
absent.

**#2041 is superseded regardless.** The reviewer found it calls an undefined
`configuredAutoReviewModel()` — a runtime `ReferenceError` — and bumps `package.json`
on top of being CONFLICTING. #2363 is the better vehicle even though it is not yet
sufficient. #2041 closes in wp8.

## #2364 — FAIL

Commit 1 wired management validation and `safeConfigDTO`; **commit 2 deleted both.** The
reviewer proved the consequence live against the PR head:

```
mgmt invalid   null          <- schema-invalid body accepted
dto.vercelGatewayRouting  undefined   <- valid config hidden from GET /api/config
```

So `POST /api/providers` can persist config that `loadConfig` later rejects, salvaging
away the whole provider. OpenRouter — the direct parallel this PR models itself on —
validates at exactly that site. Docs are also absent, which #1406 explicitly required.

One reviewer finding is worth recording as *dismissed*: CodeRabbit asked for the payload
under `providerOptions.gateway`. Vercel's Chat Completions documentation accepts the
top-level `provider` shorthand, which is what the issue and the maintainer asked for.
The AI reviewer was wrong; the PR is right on that point.

## #2362 — reviewed directly after a failed dispatch

Its lane produced nothing across three wait cycles and was retired under
DISPATCH-RETIRE-01 rather than waited on indefinitely. Reviewed by the main agent
instead.

It adds three new config keys — `modelResponsesCompatibility`,
`modelResponsesTerminalRepair`, `responsesTerminalRepair` — to
`src/types/provider.ts` and reads them in `src/providers/registry.ts`. The changed-file
list is:

```
src/providers/registry.ts
src/types/provider.ts
tests/deepseek-inbound-wire.test.ts
```

Neither `src/config.ts` nor `src/server/auth-cors.ts` appears. Comparable per-model keys
on `dev` are validated in both — `modelAdapters` has
`modelAdapterRecordConfigError` at `src/config.ts:1463` **and**
`src/server/auth-cors.ts:615`. This is the same structural gap #2364 was failed for,
so it gets the same disposition rather than a pass by luck of which lane returned.

The escape-hatch logic itself is gated on `effectiveAdapter === "openai-responses"` and
falls through to the registry policy, so it is opt-in and does not change default
behavior — the design is sound. It is the config-surface wiring that is missing.

## Why three PRs are left open rather than closed

Each carries real, correctly-diagnosed intent from a contributor who found genuine
problems. Closing them would discard that over fixable gaps. Each gets its blockers
restated on the PR with the exact evidence, so the author can finish the work — which is
the outcome the repository actually wants.


---

# AMENDMENT — #2362's reviewer returned late, and it found more than the main agent did

The `xai/grok-4.6` lane for #2362 was retired under DISPATCH-RETIRE-01 after three
silent wait cycles, and the main agent reviewed the PR directly instead. **The lane then
returned**, with a stronger result than the direct review produced. This is recorded
rather than discarded, because the honest comparison is the useful part.

## What the direct review found

One structural gap: three new operator-facing config keys added to
`src/types/provider.ts` with neither `src/config.ts` nor `src/server/auth-cors.ts` in the
diff, benchmarked against `modelAdapters`, which is validated at both
`config.ts:1463` and `auth-cors.ts:615`. That finding stands.

## What the retired lane found on top

Three defects in the resolver itself, all **reproduced by the main agent** in a
throwaway worktree at the PR head before being accepted:

```
B2 canonical-openai:      {"graceMs":500}
B4 invalid-falls-through: {"graceMs":750}
B3 My-Model: {"graceMs":500}  my-model: {"graceMs":1500}  MY-MODEL: {"graceMs":1500}
```

1. **The canonical ChatGPT forward provider can opt into repair.** `authMode: "forward"`
   plus `responsesTerminalRepair` wraps the canonical SSE in the DeepSeek repair
   machine, which #1809 rules out. `providerConfigSchema` is `.passthrough()`, so a
   hand-edited `config.json` loads it even though management POST would reject it.
   `isCanonicalOpenAiForwardProvider` already exists and is not consulted.
2. **An invalid per-model grace re-enables repair through the provider default.**
   `{ foo: 0 }` reads as "disable this model" and instead falls through to
   `responsesTerminalRepair: 750`.
3. **Duplicate case-folded keys resolve by request casing.** One model, two grace
   windows, decided by how the caller spelled it.

Plus: the effective-wire check reimplements a looser lookup than
`resolveWireProtocolOverride` actually uses; `graceMs` is uncapped
(`Number.MAX_SAFE_INTEGER` accepted); and two of the new "fail-closed" tests are
tautological — they assert `undefined`, which the old code already returned, so they
survive a revert of the source change.

## The lesson worth keeping

DISPATCH-RETIRE-01 exists so a silent lane cannot stall a loop, and retiring it was
correct — the phase would otherwise still be waiting. But **retirement is not a verdict**.
The main agent's fallback review was thinner than the lane's, and had the late result
been dropped on the grounds that the lane was already retired, three reproduced defects
in a config surface would have gone unrecorded.

Practical rule for later phases: when a retired lane returns after its replacement work
is done, re-read it against what was already concluded. Cheap to check, and here it
changed the evidence on the PR.

Findings posted to #2362 as comment `5379825296`. Disposition is unchanged —
**LEAVE OPEN** — but the blocker list is now materially longer and measured.

