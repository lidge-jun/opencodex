# Next-release supersession and landed backlog cleanup

Prepare focused replacement PRs, preserve original authors and useful regressions, and close only covered source work. The owner later authorized serial integration into `dev` after the ongoing main release completed. Release 2.77.0 passed that gate before integration began. [Integration results](031_integration_results.md) records the current landings and remaining limits; release publication and installed-runtime changes remain outside this task.

## Loop specification
- Archetype: satisfy-spec; triggered by the owner request on 2026-10-04 to refine candidates into lanes, supersede source PRs and close already-landed backlog.
- Goal: attributed replacement PRs with honest verification and source coverage; evidence-backed issue/PR dispositions.
- Non-goals: publish a release, deploy, change installed runtime/accounts, delete branches, blanket-close unrelated backlog, or use native GitHub stacks. Before the release gate passed, merging was also excluded; the owner steering below superseded that initial limit.
- Verifier: source PR diffs and current dev implementation; per-lane focused regression/typecheck/structure/privacy evidence; gh PR/issue state and linked disposition readback. Coordination document checks inspect these numbered files and coverage of all ten selected sources. No product test is claimed by document validation.
- Stop: selected sources have reviewed replacements or explicit evidence-backed exclusions; accepted PRs have verified serial dev landings after the release gate; eligible originals and landed issues have verified dispositions; unresolved behavior stays open.
- Memory artifact: this unit; ignored .tmp/next-release source snapshots, lane manifest, closure ledger and review evidence. Security analysis only in ignored scratch.
- Outcomes: DONE for verified preparation/disposition; unmet external/runtime evidence is explicitly recorded and affected replacement remains draft; no fabricated green checks.
- Escalation: scope growth, unique original behavior lacking replacement, missing attribution, ambiguous landing, conflicting current work. Main resolves within authorized scope; unresolved cases remain open.
- Resources: existing local/gh tools and account only; local isolated worktrees plus scoped GitHub PR/comments/closure. No user-set token or wall-clock budget. Bounded commands, focused tests, no full/changed suite across competing lanes; broader coverage goes to exact-head CI. No live paid-provider requests.

## Repository and ownership
Runtime src/, domain tests/, structure/ ownership docs, docs-site/ user guides, gui/ for Claude settings. Nested AGENTS.md and MAINTAINERS.md govern each lane. Baseline dev observed 0818ea1812a028e1c14cd0b0511b44863407bc52; refresh before execution and closure.

## Dependency order
1. wp0: docs-only roadmap, architect proposal/reflection, independent audit, document verification.
2. wp1: independent worktree lane publication after roadmap locks. Each lane owns its code plan, audit, implementation and check. Source closure remains with coordinator.
3. wp2: verify replacement coverage, then link/close superseded originals and fully landed backlog. Read-only PR/issue discovery may run during wp0/wp1; mutations wait for the gate.
4. wp3: verify the current main release completed, then integrate accepted PRs serially with fresh head/base CI, reviews and attribution. Reconcile issue acceptance after actual dev landing.

## Candidate boundary
Sources: #6530 #6537 #6533 #6534 #6547 #6521 #6488 #6548 #6525 #6524.
No source is closed merely because a new PR exists. Partial coverage retains the original until missing useful scope is explicitly represented; rejected scope has a concrete reason. Issues stay open until implementation is on dev and their acceptance scope is satisfied.

## Consultation
Architect 01a10486-414f-70a3-ac7f-784517360940 supplied NR-A/B/C/D/E/F, NR-DEP, NR-ACCEPT and NR-CLOSE. Main accepted the six-lane structure and recorded boundary amendments in 010. Same-agent reflection returned ALIGNED with no material coordinator gaps against 000/010/020. Independent auditor 01a1048c-c289-7a40-b964-811afb994551 returned VERDICT: PASS, no material blockers, and passed fresh-reader review.

Document verifier preflight: `python3 .tmp/next-release/check-roadmap.py` exited 0; reads all three numbered docs, checks ten pinned source SHA/path maps and six-lane/closure boundary. `git diff --check` exited 0. Product tests are not applicable to this docs-only cycle.

## wp0 conclusion
Roadmap locks six isolated lanes and ten selected sources. No production changes were made. Independent survey found no fully landed open PR ready for closure among 56 non-selected open PRs; partial work is preserved. Next cycle executes lane publication; final disposition still requires source-head/coverage/attribution verification.

## wp1 P revalidation
Previous D locked the six-lane roadmap without production changes. This cycle consumes unchanged 010 and the completed NR-A..F architect proposal/reflection. Source snapshots and base remain recorded; each lane rechecks current heads before code. Executable dispatch prompts are .tmp/next-release/lane-prompts.json and preserve all 010 restrictions. No design decision changed.

## Owner steering — conditional integration (2026-10-04)
After the ongoing main release actually completes, owner authorizes this coordinator to merge the prepared next-release PRs into dev. Before that boundary, only PR preparation and issue/PR disposition. This supersedes the earlier no-merge boundary for the coordinator only; lane merge authority remains withheld. No new release/deployment is authorized. Host goal text is immutable through the available tool; this append and wp3 record the continuing goal scope without replacing the active goal.

## wp3 conclusion

The accepted set is integrated: 12 PRs, including the #6565 review repair, landed after the verified 2.77.0 release gate. Nine source PRs were superseded; four issues closed with actual landing evidence. Restart #6556 remains a deferred draft with source #6548 open. Partial/live acceptance issues remain open. [The final report](031_integration_results.md) links each merge and successful candidate CI. The final remote checker exited 0, and the reader check clarified completion and #6529 scope. No next work-phase is required for this agreed set; release publication, runtime installation and deferred acceptance remain outside the completed scope.

The initial assumption that a green reviewed PR necessarily closed all recovery paths was disproved by later review: parent-qualified Devin identity required #6565, and A4 required accepting read-only owner publications while write gates are closed. Both were repaired and reverified. Native/live and continuous Windows audit limitations did not improve in this cycle and remain explicit. Reopened acceptance evidence or a new reproducible regression would require a new scoped follow-up, not retroactive claims about these checks.
