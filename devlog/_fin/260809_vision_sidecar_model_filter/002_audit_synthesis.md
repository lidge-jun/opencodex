# 002 — A-phase audit synthesis (round 1)

Reviewer: independent subagent on `xai/grok-4.5`, high effort, read-only.
Verdict: `GO-WITH-FIXES (blockers=5)`.

Every blocker below was **re-verified by the main agent against the tree** before
being accepted; none was taken on the reviewer's word.

## Root-cause synthesis

Blockers 1 and 2 are one defect, not two. I wrote the write-gate as *"reject what
is not in the picker"* while writing the bypass table as *"an operator may point
at a model the catalog does not know about"*. Those cannot both hold: an unknown
id is absent from the option list by construction, so the gate would reject
exactly the case the bypass table promises to allow.

The correct rule follows from the tri-state the predicate already returns:

```
option list  = eligible AND reachable AND known   (a suggestion — may be narrow)
write gate   = reject only when modelAcceptsImageInput(...) === false  (a proof of harm)
```

`undefined` (nothing knows) belongs on the permissive side of the gate and the
conservative side of the list. Conflating "not suggested" with "forbidden" is the
error; the fix is to stop deriving the gate from the list.

Blockers 3, 4, 6, 8 are all under-specification of a real call site — I named a
behavior and left the implementer to find the writes. Blocker 5 is a scope claim
I made too broadly.

## Accept / rebut

| # | Sev | Finding | Decision | Verification I ran |
|---|-----|---------|----------|--------------------|
| 1 | Critical | PUT 400 would reject unknown ids and break an existing contract test | **ACCEPT** | `tests/vision-reasoning-contract.test.ts:148-151` really does assert `putVision(custom, { model: "custom-vision" })` → 200 with `providers: {}`. My gate would have turned that red. |
| 2 | High | GET grandfathers the configured model, PUT does not | **ACCEPT** | Same root cause as 1; fixed by the same rule change. |
| 3 | High | `saveSidecar` drops `visionModels` on the success path | **ACCEPT** | `use-dashboard-data.ts:480-485`: `setSidecar({ webSearch: data.webSearch, vision: data.vision })` and the cache write both enumerate fields explicitly, so a new field is silently dropped. Three write sites, not one. |
| 4 | High | `config.providers.openai && !disabled` is not this repo's "OpenAI side enabled" | **ACCEPT** | `listOpenAiForwardSidecarCandidates` (`src/providers/openai-sidecar.ts:55-70`) additionally requires `isCanonicalOpenAiForwardProvider` (`openai-tiers.ts:32-36`): `openai-responses` + `forward` + canonical base URL. My predicate was strictly broader and asymmetric with the Anthropic side. |
| 5 | High | Requirement 2 ignores the Claude Code vision override | **ACCEPT IN PART** | `gui/src/pages/claude-code-sections.tsx:154-205` is a freeform `<input>` with a `<datalist>`, not a picker, and `agent-settings-routes.ts:1002-1014` only type-checks `model`. I accept the **server** half (the gate must cover every route that sets a vision describer) and rebut the **GUI** half (a freeform text input is deliberately freeform; narrowing its suggestions is a different product decision). Recorded as an explicit scope statement, not silence. |
| 6 | Medium | Card does not really adopt the delegation form factor | **ACCEPT** | `dash-delegation-summary` is applied to the *panel* at line 102; my draft put it on an inner row where `.dash-sidecar-card__row` already supplies the same flex rules. Redundant, and it would not match. |
| 7 | Medium | Wrong seam named for route tests | **ACCEPT** | The real seam is `handleManagementAPI` + `tests/helpers/management-auth`, demonstrated by `tests/vision-reasoning-contract.test.ts:12-31`. `model-routes.ts` documents a `deps.saveConfigPreservingClaudeCode` injection that the sidecar route does not use — it calls the bare import at line 469. |
| 8 | Medium | Compact CSS rule proposed in the wrong file | **ACCEPT** | The `min-width: clamp(10rem, 24vw, 11.5rem)` it must override lives in `styles-dashboard-workspace.css:104-110`, not `styles.css`. |
| 9 | Low | Stale line citations | **ACCEPT** | Re-pinned below. |
| 10 | Low | docs-site / CLI consumers omitted | **ACCEPT** | `src/cli/agent.ts` writes through the same PUT, so it inherits the corrected gate for free; `docs-site/src/content/docs/guides/sidecars.md` needs a sentence (SOT-SYNC-01, phase 2's C). |

Reviewer claims I **rebut**: none outright. The one partial rebuttal (5) is scoped,
not dismissed.

Reviewer claims I independently confirmed as *correct in my favor*: the
`:last-child` selector is robust (`Select` renders sibling `.custom-select` roots),
and the delegation panel itself needs no change because it already maps efforts to
raw values (`dashboard-overview-sections.tsx:119-122`). So comment 2's "여기처럼"
is a pattern reference, not a request to edit that panel.

## Amendments applied

1. `010` — `visionEligibleModelOptions` unchanged, but the doc now states the
   list/gate asymmetry explicitly and adds a test asserting the tri-state.
2. `020` — the 400 guard is rewritten to fire only on
   `modelAcceptsImageInput(...) === false`; `enabledVisionBackends` now uses
   `listOpenAiForwardSidecarCandidates`; the same guard is applied to the Claude
   Code vision override route; the seam is named correctly; a docs-site sync line
   is added; two tests are added (unknown id keeps 200, Claude Code route rejects).
3. `030` — the card becomes `panel dash-delegation-summary`; all three
   `visionModels` write sites are enumerated; the CSS rule moves to
   `styles-dashboard-workspace.css`.
4. `000` — bypass table restated so the enforcement claim matches the code, and
   the Claude Code scope boundary is written down.

## Re-pinned anchors

| Symbol | Real location |
|---|---|
| `planVisionSidecar` | `src/vision/index.ts:231` (its `modelInList` guard at 238) |
| `findAnthropicVisionProvider` | `src/vision/index.ts:172` |
| vision card markup | `gui/src/pages/dashboard-overview-sections.tsx:288-311` |
| delegation panel | `gui/src/pages/dashboard-overview-sections.tsx:102-104` |
| delegation raw effort labels | `gui/src/pages/dashboard-overview-sections.tsx:119-122` |
| sidecar select min-width | `gui/src/styles-dashboard-workspace.css:104-110` |
| `saveConfigPreservingClaudeCode` call in PUT | `src/server/management/config-routes.ts:469` |

Confirmed accurate as originally written: `provider-fetch.ts:574-582`,
`config-routes.ts:380-393`, reasoning enum check `422-423`, `model-rows.ts:45-54`,
`use-dashboard-data.ts:454-462`.

# Round 2

Same reviewer, re-audit of the amended documents. Verdict:
`GO-WITH-FIXES (blockers=1)`. Eight of nine prior findings confirmed **CLOSED**,
including the reviewer walking the `custom-vision` input through the amended
predicate step by step and reaching `undefined` (so the contract test stays
green), and confirming `.dash-delegation-controls .custom-select:last-child`
touches no other surface (`dash-delegation-controls` has exactly two users, and
the delegation panel's last child is a `<button>`).

## N1 (High) — ACCEPTED, and it was a real defect

Two halves, both verified by me before accepting:

1. **The fenced JSX still shipped the old structure** while the prose above it
   described the new one. An implementer executing the fence verbatim would have
   re-applied blocker 6. The fence is now rewritten to match.
2. **The dual-class panel would not have produced a row.**
   `.dash-sidecar-card` declares `flex-direction: column`
   (`gui/src/styles-dashboard-workspace.css:84-89`) and `.dash-delegation-summary`
   (`gui/src/styles.css:2245-2250`) sets `display/align-items/justify-content/gap`
   but **never** `flex-direction`. Different properties do not compete, so import
   order is irrelevant — column would simply have survived. My "confirm in render
   grounding" hedge was wrong: this was decidable statically, and I should have
   decided it. Fixed by dropping `dash-sidecar-card` from the vision panel and
   adding `.dash-vision-card { min-width: 0; }` for the only property the grid
   cell actually needed.

## N2 (Medium) — ACCEPTED as an explicit product decision, not a silent residual

A proven-blind configured model stays visible in GET but is rejected on re-save.
Documented in `020` case 2 with the reasoning: effort-only edits bypass the model
guard, and hiding the configured id would show a different model than the one the
config actually names.

## N3 (Low) — ACCEPTED

`visionCandidateRows` is now written out as concrete code so layer 2 is
copy-paste complete.

## Stale crumbs — both fixed

`000`'s field-chain row still named only the `sidecarModels` memo and a single
serialization site; it now names the `visionModels` memo, all three `saveSidecar`
writes, both serialization sites, and the second validation route.

## My own measurement, added to 020

I enumerated what the synthesized fallback candidate can reject: exactly
`codex-mini-latest`, `gpt-4`, `o3-mini` on the openai side and nothing on the
anthropic side. All three are genuinely blind, so there is no false-positive
surface.
