# wp1 — audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp1` · A phase

Reviewer verdict: **FAIL**, 5 blockers (1 High, 4 Medium). Recorded before any
re-dispatch, per REVIEW-SYNTHESIS-01.

## Disposition

| # | severity | disposition | where |
|---|---|---|---|
| 1 | High | **accepted** — real defect in the planned implementation | `011` constraint 4 rewritten |
| 2 | Medium | **accepted** — criterion withdrawn as non-discriminating | `011` accept criteria 4a/4b |
| 3 | Medium | **accepted** — stale cross-references | `000` phase table, `030` rollback |
| 4 | Medium | **accepted** — full suite is the gate | `011` verification block |
| 5 | Medium | **rebutted with evidence** | `011` documentation disposition |

## Root cause of blocker 1 (the one that mattered)

The plan said "detect code mode from `parsed.context.tools` — the objects, while
`freeform` is still present." That sentence is half right and the half that is
wrong is load-bearing.

`freeform` does only exist on the requested objects, so detection must start
there. But the *decision* is about the shape of the catalog the model receives,
and those two sets differ whenever the budget drops something. The reviewer
built the divergent case: 49 tools, `exec` emitted, `exec_command` omitted. A
requested-list scan sees a shell bridge that the model cannot call and concludes
"not code mode" — suppressing the exact sentence this unit exists to restore,
in precisely the crowded-catalog sessions where delegation matters most.

The fix is to intersect: take the predicates from the requested objects, then
keep only those whose alias survived into the emitted set.

A pleasing side effect is that constraints 3 (`tool_choice: "none"`) and 4
(budget omission) stop being separate rules to remember. Both reduce to "the
emitted set is empty, so nothing is named." Fewer independent invariants is
fewer ways to be wrong later.

## Why blocker 5 is rebutted rather than folded

`src/AGENTS.md:28` is a real instruction and the reviewer was right to raise it.
The rebuttal is factual, not procedural: `rg` across `docs-site/src/content/docs`
finds no mention of `ALL_TOOLS`, `code mode`, or the catalog nudge anywhere,
including `reference/adapters.md`. There is no page this change makes untrue.

The instruction exists to stop docs drifting from code. Writing the first-ever
description of an internal prompt-assembly detail, as a rider on a parity bug
fix, does not serve that purpose — and a partial description covering only Kiro
would itself be misleading, since four other adapters have had this behavior all
along.

## Cross-blocker conflicts

None. Blockers 1 and 2 both push toward the emitted catalog as the source of
truth and were folded as one amendment.

## Independent corroboration

A second read-only lane audited the injection budget in parallel and returned
**BOUND-RISK: NONE**: `boundedInjectedInstruction` (`kiro.ts:398`) truncates from
the tail and the code-mode sentence sits late in the nudge, so a budget squeeze
*would* remove exactly the restored sentence — but a maximum-pressure synthetic
catalog measured 6,176 injected chars against a 16,384 bound, leaving 10,208
free. The code-mode nudge is 718 chars longer than the fallback it replaces.

Recorded because the margin is a fact this unit now depends on: if
`MAX_KIRO_TOOL_COUNT` or the nudge grows substantially later, the tail-truncation
ordering becomes live and the sentence is what gets cut first.

## Round 2

Verdict moved **FAIL -> GO-WITH-FIXES (blockers=1)**.

| # | round-2 status |
|---|---|
| 1 High | CLOSED — reviewer re-reproduced 4a (code mode now enabled) and 4b (suppressed), and confirmed the intersect has no hole: namespaced `exec` is excluded by `tool-catalog-nudge.ts:32`, and the completion tool cannot collide because `kiro-wire.ts:87-88` rejects that requested name |
| 2 Medium | CLOSED — 4b shown deterministically testable: equal priority keeps request order (`kiro-tools.ts:210`), so 48 fillers then `exec` omits `exec` |
| 3 Medium | **STILL-OPEN in round 2, closed after** — `000_plan.md` still asserted the superseded cause; now carries supersession headers on Mechanism, the failure chain, and the design-constraint section |
| 4 Medium | CLOSED |
| 5 Medium | CLOSED, **with a factual correction against me** |

### The correction worth keeping

My round-1 rebuttal of blocker 5 cited an `rg` that returned no hits for
`ALL_TOOLS` in `docs-site/`. That was false. The reviewer found
`guides/codex-integration.md:314-316` describing exactly this path; my search
had covered `reference/` and missed `guides/`.

The conclusion survived — the page is adapter-neutral, so restoring Kiro parity
makes it *more* true rather than wrong — but it survived for a different reason
than I gave. Had that guide said the path already worked on every routed
provider, the correct disposition would have flipped to a docs edit, and a
no-hit search would have concealed it.

This is the concrete value of the adversarial lane: it caught a load-bearing
claim that was convenient and wrong, in the one section where I was arguing
against the reviewer rather than with them.
