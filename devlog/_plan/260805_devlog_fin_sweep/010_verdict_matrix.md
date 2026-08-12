# 010 — Per-unit verdicts

53 units, each adjudicated by a read-only agent against the tree and the live
GitHub state, then audited. `ON_DEV` below means
`git merge-base --is-ancestor <sha> dev` returned true.

The count moved during the sweep. The first inventory found 51; by the time the
audit ran, `_plan/` held 53 — this unit itself, plus `260805_issue_pr_triage`,
which a concurrent session opened at `2026-08-05T13:33:08Z`. Both are live work
and neither is archivable. That is why the audit found the plan's arithmetic
stale, and it is a fair reminder that a directory listing is a snapshot, not a
fact.

## COMPLETE — 11 units, archive to `_fin/`

Each row names the past-tense outcome record that qualifies the unit, per the
standard settled in round 3.

| Unit | Outcome | Evidence |
|---|---|---|
| `260730_devlog_publication_feasibility` | DONE | `000_plan.md:3-5` "EXECUTED on local dev", WP1-WP4 closed; `030_wp3_wp4_execution_record.md:192` records DONE; `8ae52e429` (publish devlog as tracked files) and `50cbf5162` (scanner stops flagging its own proof) ON_DEV |
| `260730_issue543_kiro_midturn_steer` | DONE | `022_posted_comment.md:1` "Fixed on our side, so I'm closing this"; `12dbec30a` ON_DEV; issue #543 CLOSED; carrier-ordering code + two regression tests present |
| `260730_issue_triage_dev_head` | DONE | `000_triage_matrix.md:54-62` records #655 CLOSED, #553 relabelled, no PR action by design; `cec8c1a9c`, `998ebada1` ON_DEV |
| `260730_kiro_usage_cumulative_cache` | DONE | `030_upstream_cache_frame_probe.md:27,64` H1 confirmed, cache c/w disposed as upstream-unreported with no code change; `e3f406813`, `ee69abf1d` ON_DEV |
| `260731_structure_sot_refresh` | DONE | `070_closeout.md:1-16` explicitly records DONE for WP0-WP6; six closeout commits ON_DEV; claimed `structure/` edits present |
| `260801_pr611_volcengine_evidence` | DONE | PR #611 MERGED into `dev` 2026-08-01; `4548310ea`, `688fd7715` ON_DEV; issue #825 (only residual) CLOSED; Volcengine presets + disclosures in `src/providers/registry.ts` |
| `260802_bugfix_280` | DONE | `070_integration.md:44-57` records merge, gate, CI, push, issue close; five fix commits ON_DEV; issues #858/#855/#859/#864/#857/#848 CLOSED |
| `260802_issue_pr_triage` | DONE | `010_triage_matrix.md:4,135-141` complete inventory + next queue; successor unit `260802_triage_execution/000_research.md:3` records this one audited PASS |
| `260803_bug_backlog_stack` | DONE | `070_outcome.md` records the shipped stack; PRs #951-#955 MERGED; `c72dc9963`, `6ebc81ab1`, `d1a525dcb` ON_DEV; issues #908/#545/#915/#907/#875 CLOSED |
| `260803_sparse_snapshot_repair` | SUPERSEDED | `000_plan.md:15` "Not started"; `260805_bug_stack_campaign/040` re-specified it; `a81468792`, `a5a7822df` ON_DEV; `responsesSnapshotRepair` + tests exist; issue #893 CLOSED |
| `260804_overnight_triage` | DONE | `000_dispositions.md:7-19` terminal dispositions for all nine PRs; `9c110d87a`, `833406628` ON_DEV; PRs #961/#963-#968/#970 CLOSED, #969 MERGED |

### The calls the audit reversed

Eight units left this column across three audit rounds, all for one reason:
**landed code is not a closed unit.**

**`260803_integrations_toggle_all`.** The
first pass archived it because `6f93a10a7` and its four-commit build are on
`dev` and the routes, inspector and tests all exist. The audit pointed at the
unit's own `000_plan.md:13`, which still reads "Still a docs-only Phase-0 cycle;
no implementation yet", and at four decade docs whose acceptance boxes are all
unchecked.

That is precisely the condition this sweep uses to KEEP `500_storage-page-session-cleanup`
open — implementation landed, record never caught up. Applying it there and not
here would make the rule decorative. The unit moves to the OPEN column and needs
one closeout doc reconciling its checklists against what shipped.

**`260731_api_tab_improvement`** and **`260802_api_tab_client_connect_simplify`**
went the same way in round 2, once the precedent existed. The first has five
landed commits and no closeout: `040_gui_detail_and_matrix.md:15` says the
contract is what `030` "plans to ship, not evidence that it has shipped", and
`050` is a forward-looking final-phase plan. The second records its own required
GUI gates — `bun test tests`, `lint`, `build`, `lint:i18n` — as "not yet run"
at `010_client_connect_rows.md:242-245`, and `030` flags a validator artifact as
"measured but unarchived" pending a future unit.

**`260802_client_toggle_api`** was defended in round 2 on the grounds that `041`
is a build record and `080` opens "The feature is on `origin/dev`", so the
unticked boxes in `040` did not matter. Round 3 demolished that by reading
further into the same document: `080_ci_stabilization.md:117-142` records seven
cross-phase defects, five fixed and **three deferred** — OpenClaw ignoring its
documented path overrides (explicitly "release-blocking for the OpenClaw
integration"), export serializers throwing 500s on valid user documents, and an
Undo/drift-detection disagreement. The document then says: "Each is its own
work-phase, appended to the goalplan."

A unit that names three live work-phases in its own stabilization record is not
finished. The carve-out was special pleading and the demotion is correct.

### Round 3: four more, and the standard that finally settled

`260730_prerelease_blockers`, `260730_server_auth_suite_flake`,
`260804_stack7_service_vision` and `260804_stacked_pr_ci` all have their work on
`dev` and their issues closed. Their final documents are still procedures and
prospective test lists — a push sequence to run, a merge order to follow, tests
that "must" assert something — with no record that any of it happened.

There is a real argument for archiving them anyway: the push demonstrably
occurred (the commits are ancestors of `dev`), the merges demonstrably occurred
(the PRs are closed), so completion is inferable from outside evidence.

That argument is not taken. `_fin/` is supposed to mean the record is closed, and
inferring closure from git while the unit's last page still reads as an
instruction leaves the next reader to redo the inference. Three audit rounds
spent re-litigating this exact line is itself evidence that the looser bar does
not hold. Ambiguity resolves toward `_plan/`, as `000` said from the start.

The bar that survived: **archive when the unit's own record states an outcome in
the past tense** — an outcome doc, a closeout, an execution record, a disposition
table, a posted comment, a verdict. Not when the code merely landed.

### Round 4: the standard applied to itself

`260731_260730-gui-sidebar-star-update-orbs` was the last unit to fall, and it
fell to the rule stated one round earlier. Its final document `040_verification.md`
is a list of commands to run and browser checks to perform — "Check in the
browser: 1. Sidebar footer... 2. Click the update orb..." — with no record that
anyone ran them. The commits are on `dev`; the verification is unrecorded.

Round 4 also confirmed a qualifying past-tense record for each of the remaining
twelve, individually cited in the table above. That is what makes this the last
round: the demotions stopped finding new targets and the survivors each produced
their receipt.

### Two calls worth defending

**`260803_sparse_snapshot_repair`** reads OPEN on its face — its own status line
says "Not started" — and is archived anyway. The reason is that the work it
reserved was executed elsewhere: `260805_bug_stack_campaign/040` re-specified
the same #893 repair, `a81468792` landed it, the implementation and tests exist,
and the issue is closed. Leaving the stub in `_plan/` would advertise work that
cannot be done twice. This is the SUPERSEDED disposition, and it is the only one
in this sweep.

Its sibling `260803_transport_attribution` looks identical and is NOT archived,
because only half of it was superseded: #914 landed, but #919 is still OPEN and
the unit owns it.

**`260801_pr611_volcengine_evidence` was challenged in round 4 and is retained.**
The reviewer read `010_note_disclosure_and_merge.md` (a plan) and
`011_audit_synthesis.md` (headed "verdict FAIL") and concluded the unit has no
outcome record, only an inference from PR #611 being merged.

That misses the file where the outcome actually lives.
`000_evidence_ledger.pre-merge-local.md:69` is a `## Outcome` section, and it is
retrospective throughout: PR #611 merged as `4548310ea` at a stated timestamp,
CI 6/6 green on the merged head, 65 presets matching the docs claim, three
`CHANGES_REQUESTED` reviews dismissed with per-review rationale, and the
coding-tools-only disclosure defect fixed in `688fd7715` — including the
renamed-preset case, ablation-verified. The one gate item that could not be
closed, a named maintenance owner, is tracked at #825 rather than waived, and
#825 is CLOSED.

The "verdict FAIL" header in `011` is an audit ROUND label, not the unit's
disposition: that document records four blockers accepted and folded plus three
rebutted, which is the audit loop working, not an unresolved failure. Judging a
unit by the first heading in one of its files is exactly the error this sweep
warns about elsewhere.

## OPEN — 41 units, stay in `_plan/`

| Unit | Why it stays |
|---|---|
| `260701_codex-catalog-split` | `90_progress.md` "ORACLE LANDED, file split DEFERRED"; the split modules do not exist |
| `260730_codex_rs_upstream_v2_live_handoff` | `000_plan.md:3-4` "Implementation starts at the NEXT loop run"; WP7 has no B/C/D closeout |
| `260730_gui_hydration_loading_unify` | `PROGRESS.md:399-402` WP7 PARTIAL, control removal awaits user approval |
| `260730_remote_issue_merge_round` | issue #572 umbrella OPEN; Windows Bun panic explicitly left for separate work |
| `260731_macos_rss_retention` | `110_verify_and_push.md:94-99` documents a follow-up "documented not executed"; issue #820 OPEN |
| `260731_pr_issue_triage_round` | `000_plan.md:182-187` archival is conditioned on a successor unit that does not exist; PR #715 and five issues OPEN |
| `260731_pr_landing_round` | phases 010-040 planned only; privacy-scan blocker still stated as prerequisite |
| `260731_pr_merge_round` | PRs #557/#569/#581/#715 OPEN as explicitly deferred next-cycle work; issue #796 OPEN |
| `260731_api_tab_improvement` | five phase commits ON_DEV, but `040:15` still describes the contract as planned-not-shipped and `050` is a forward-looking plan; no closeout (audit r2 blocker 2) |
| `260802_api_tab_client_connect_simplify` | `010:242-245` records the phase's GUI test/lint/build/i18n gates as "not yet run"; `030:176` leaves the validator artifact unarchived (audit r2 blocker 3) |
| `260731_client_config_export` | `050_docs_and_hardening.md:3` opens a SECOND work-phase ("appended after the four implementation phases closed") and ends at acceptance criteria with no execution record. Its criteria are in fact satisfied in the tree — `ocx export` is documented at `docs-site/src/content/docs/reference/cli/agents.md:149`, the Pi and OpenCode guides exist, and `OPENCODEX_OPENCODE_API_KEY` agrees between `src/clients/config-export.ts` and the docs — but the unit never records that, so it needs a one-line closeout, not an archive (audit r4) |
| `260730_prerelease_blockers` | `030_push_and_issue_closeout.md` is a push/close procedure; the push happened but the unit never records that it did (audit r3) |
| `260730_server_auth_suite_flake` | `010_unique_fixture_dirs.md:69-85` is a verification plan stating what must be confirmed three consecutive times; no recorded result (audit r3) |
| `260802_client_toggle_api` | `080_ci_stabilization.md:117-142` defers three defects, one release-blocking for OpenClaw, each "its own work-phase, appended to the goalplan" (audit r3 blocker 2) |
| `260804_stack7_service_vision` | `030` is a prospective merge sequence and `040:99` a prospective test list; the merges happened but the unit does not say so (audit r3) |
| `260804_stacked_pr_ci` | `010`/`020` end at imperative verification and risk sections with no executed outcome; `020` also records that live label behavior cannot be proven from `dev` (audit r3) |
| `260731_260730-gui-sidebar-star-update-orbs` | `040_verification.md` is a command list and browser-check procedure; nothing records that the gates or the rendered checks were run (audit r4) |
| `260731_windows_bun_stability` | `000_research.md:244-278` unresolved questions and unapplied candidates |
| `260801_monorepo_git_blobless_strategy` | phases 2-3 unchecked; no `filter: blob:none` or contributor guidance in the tree |
| `260801_native_main_profiles` | `001_validation.md:48-51` lists CI, live-keyring, manual E2E evidence still owed |
| `260801_zero_leak_state_stores` | `070_close_and_push.md:5` "Execution status: procedure only" — the closeout gate never ran |
| `260802_429_same_target_retry` | design outline with no executed outcome; upstream openai/codex#30471 OPEN |
| `260802_codex_set_prompt_composer` | only WP1 landed; WP2-WP7 remain specifications, no route or GUI in tree |
| `260802_gui_update_service_recovery` | WP5 has no DONE/NOOP disposition; `src/lib/bun-runtime.ts:169` still lacks the specified validation |
| `260802_triage_execution` | `030_close_defer.md:42-45` deferred #616 until #837 lands; both closed unmerged, no terminal record |
| `260802_wt1_update_path_star_prompt` | Bug C left optional; PR #557 OPEN |
| `260802_wt3_provider_wire` | no executed closeout; the #875 comment obligation has no execution record |
| `260802_wt4_server_config_security` | both work phases recorded as prospective ("will be applied"), no verification closeout |
| `260802_wt5_windows_service_doctor` | no terminal outcome; stated real-Windows verification limitation unresolved |
| `260803_ci_dev_lane_sharding` | phase 3 close-out evidence (dispatch Windows run, measured critical path) not recorded |
| `260803_codex_desktop_toggle` | `050_desktop_toggle.md` unimplemented; no `removeDesktop3pConfig` in tree; owns the two clients the sibling unit dropped |
| `260803_cooldown_recovery_probe` | `000_plan.md:28` "Not started" while #915 landed — stale record needs reconciling, not archiving |
| `260803_integrations_overview_ux` | WP1-WP3 have no execution/verification closeout despite `e1f1fb56b` ON_DEV |
| `260803_integrations_toggle_all` | `000_plan.md:13` still declares itself docs-only with no implementation, while `6f93a10a7` shipped it; acceptance boxes in `011`/`012`/`030`/`040` unchecked. Needs a closeout, not an archive (audit blocker 2) |
| `260803_pr_issue_sweep` | PR #916 is CLOSED unmerged and still `isDraft: true`, so the "keep it draft pending maintainer security review" instruction in `050_phase5_916_disposition.md:113-118` was never discharged — the salvage decision is unrecorded (corrected per audit blocker 5; the original reason said the PR was still awaiting review) |
| `260803_transport_attribution` | issue #919 OPEN; only the #914 half was superseded |
| `260804_codex_write_substrate` | WP13 composed acceptance is specified but never executed; FOLLOWUP-FILECLIENT-01 deferred |
| `260804_router_intelligence` | `000_master_plan.md:1-8` status ACTIVE; RI-10 commit `7410b8851` NOT_ON_DEV |
| `260805_bug_stack_campaign` | today's campaign; #994/#904/#796/#418 OPEN, eight PRs OPEN, no terminal disposition |
| `260805_issue_pr_triage` | opened by a concurrent session today at snapshot `8949c4940`; 39 open issues and 25 open PRs under active triage |
| `260805_devlog_fin_sweep` | this unit |
| `500_storage-page-session-cleanup` | all three phases landed on `dev`, but `40`/`50` still read as future work and `90_open-questions.md` is unresolved |

### The pattern in the OPEN column

Nine of these thirty have their implementation on `dev` and stay open purely
because the unit's own record stops short — `500_storage-page-session-cleanup`,
`260803_cooldown_recovery_probe`, `260803_integrations_overview_ux`,
`260802_wt3/wt4/wt5`, `260803_ci_dev_lane_sharding`,
`260802_gui_update_service_recovery`, `260802_429_same_target_retry`.

With the nine units the four audit rounds demoted, that is eighteen.

That is a documentation debt, not open engineering. Each needs one closeout doc
recording what shipped and what was dropped, and then it archives. Writing those
is real work with real risk of asserting something false, so it belongs to a
separate unit rather than being smuggled into a file move.
