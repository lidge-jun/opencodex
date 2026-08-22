# 020 — The moves, and what breaks if you only move

## Four things a plain `git mv` would break

**1. Two gates path-pin a unit by name.** `260730_devlog_publication_feasibility`
is not merely referenced — it is hardcoded as an exemption in two places, and
both fail closed:

- `scripts/privacy-scan.ts:46` — `DEVLOG_PUBLICATION_PROOF_FILE`, consumed at
  lines 87, 130 and 147 to allow the three fake probe values that unit preserves
  as scan evidence. Move the file without editing this and `privacy:scan` reports
  a token, a home path, and an email in a tracked file.
- `tests/repo-hygiene.test.ts:156` — `TRIPWIRE_META_EXEMPT_PREFIX`, which spares
  that unit from the security-verdict tripwire. The exemption is written as a
  `devlog/_plan/` prefix.

The second one has a subtlety worth stating: the tripwire only scans
`devlog/_plan/`, and `_fin/` is exempt by design. So after the move the
exemption is redundant — the unit is out of the scanned set entirely. It still
gets repointed rather than deleted, because deleting it would silently lose the
record of why the exemption existed, and because the constant is also the
documentation of that decision.

**2. Source comments cite `devlog/_plan/<unit>/` paths.** 30 files across
`src/`, `gui/`, `tests/`, `docs-site/` cite a moving unit by full path. These are
design-of-record pointers; a stale one sends the next reader to a path that does
not exist.

**3. `../<unit>/` links run between units on opposite sides of the move.**
`260802_triage_execution` (staying) cites `../260802_issue_pr_triage/` (moving)
at `000_research.md:9`. This is now the ONLY such link: the
`260803_integrations_toggle_all` <-> `260803_codex_desktop_toggle` pair both
stay in `_plan/`, so their `../` links keep resolving untouched.

**4. Staying units cite moving units by full `devlog/_plan/` path.** The audit
caught this class after the first draft inventoried only source comments and
gates. Seven such links exist inside `devlog/` itself, listed below.

## The moves

```
git mv devlog/_plan/260730_devlog_publication_feasibility      devlog/_fin/
git mv devlog/_plan/260730_issue543_kiro_midturn_steer         devlog/_fin/
git mv devlog/_plan/260730_issue_triage_dev_head               devlog/_fin/
git mv devlog/_plan/260730_kiro_usage_cumulative_cache         devlog/_fin/
git mv devlog/_plan/260731_structure_sot_refresh               devlog/_fin/
git mv devlog/_plan/260801_pr611_volcengine_evidence           devlog/_fin/
git mv devlog/_plan/260802_bugfix_280                          devlog/_fin/
git mv devlog/_plan/260802_issue_pr_triage                     devlog/_fin/
git mv devlog/_plan/260803_bug_backlog_stack                   devlog/_fin/
git mv devlog/_plan/260803_sparse_snapshot_repair              devlog/_fin/
git mv devlog/_plan/260804_overnight_triage                    devlog/_fin/
```

11 moves. `_plan/` goes 53 -> 42; `_fin/` goes 295 -> 306.

The counts are as of the audit re-check, not the opening inventory:
`ls devlog/_plan | wc -l` = 53 and `ls devlog/_fin | wc -l` = 295. Two units
arrived while this one was being written (`260805_issue_pr_triage`, and this
unit itself), and nine left the move list across four audit rounds. 41
remaining = 30 originally-open + those nine + `260805_issue_pr_triage` + this
unit.

The move list shrank from 21 to 11 across four audit rounds. That is the number
working as intended: every unit that left did so because its own record does not
say it ended.

## Gate edits (hand-written, exact)

`scripts/privacy-scan.ts:46`

```diff
-const DEVLOG_PUBLICATION_PROOF_FILE = "devlog/_plan/260730_devlog_publication_feasibility/030_wp3_wp4_execution_record.md";
+const DEVLOG_PUBLICATION_PROOF_FILE = "devlog/_fin/260730_devlog_publication_feasibility/030_wp3_wp4_execution_record.md";
```

`tests/repo-hygiene.test.ts:156` — repoint the prefix and record why it is now
redundant rather than leaving a constant whose comment describes a `_plan/`
world.

## Reference edits (mechanical, `devlog/_plan/<unit>` -> `devlog/_fin/<unit>`)

Re-derived against the FINAL 11-unit list, not inherited from an earlier draft
(audit r4 blocker 2). The command is
`rg -l "devlog/_plan/<unit>" src/ gui/ tests/ docs-site/ scripts/ .github/ structure/ AGENTS.md`
run once per moving unit; nine of the eleven return nothing.

| Moved unit | Files citing it by full path |
|---|---|
| `260730_devlog_publication_feasibility` | 2 — `scripts/privacy-scan.ts`, `tests/repo-hygiene.test.ts` (the gate edits above) |
| `260801_pr611_volcengine_evidence` | 1 — `src/providers/registry.ts:415` |
| the other nine | none |

**Three source edits total, not thirty.** Earlier drafts of this table counted
citations for units that have since been demoted — `260802_client_toggle_api`
(21 files), `260803_integrations_toggle_all` (7), `260731_client_config_export`
(7, and they are bare unit names rather than paths in any case),
`260804_stack7_service_vision` (2). All of those units stay in `_plan/`, so
their citations are correct as written and must NOT be touched.

## Inbound links from STAYING devlog units (audit blocker 3)

| Citing file | Cites |
|---|---|
| `devlog/_plan/260802_triage_execution/000_research.md:4,9` | `260802_issue_pr_triage` (both a full path and a `../` link) |
| `devlog/_plan/260731_macos_rss_retention/110_verify_and_push.md:14` | `260731_client_config_export` |
| `devlog/_plan/260801_zero_leak_state_stores/070_close_and_push.md:117,119` | `260731_client_config_export`, `260801_pr611_volcengine_evidence` |
| `devlog/_fin/260803_pr_issue_sweep/000_plan.md:100`, `040_phase4_backlog_disposition.md:122` | `260803_sparse_snapshot_repair` |
| `devlog/_fin/260804_router_intelligence/000_master_plan.md:89` | `260730_kiro_usage_cumulative_cache` (`:90` cites `260804_stacked_pr_ci`, which stays — do NOT edit that line) |
| `devlog/_fin/260805_issue_pr_triage/001_prior_investigation_index.md:70,73` | `260803_bug_backlog_stack`, `260802_issue_pr_triage` |
| `devlog/_fin/260805_issue_pr_triage/030_cross_links.md:193` | `260803_bug_backlog_stack` (audit r4; the reviewer cited `:171`, the actual line is `:193`) |
| `devlog/_fin/260731_pr_landing_round/000_plan.md:34` | `260730_devlog_publication_feasibility` — a live diagnosis pointer, repointed (audit r3 blocker 4) |
| `devlog/_plan/260730_prerelease_blockers/000_plan.md:4` | `260730_issue_triage_dev_head` (audit r4) |
| `devlog/_plan/260804_stack7_service_vision/000_scope.md:7` | `260804_overnight_triage` (audit r4) |

These exist because their citing units were themselves demoted in round 3: once
a unit stops moving, its outbound links to units that DO move become inbound
links needing a repoint. Each demotion round therefore required re-running the
inventory, which is how they surfaced only in round 4.

One row was dropped from this table in round 5 after
`260731_client_config_export` was itself demoted:
`260802_client_toggle_api/000_plan.md:7` cites it, but both units now stay in
`_plan/`, so that link resolves untouched. Repointing it would have created a
broken `_fin/` reference to a unit that never moved — the precise failure the
ledger exists to prevent, and a good argument for regenerating the inventory
after every demotion rather than editing it in place.

Rows that dropped out when their targets stopped moving:
`260802_codex_set_prompt_composer/040:121` ->
`260802_api_tab_client_connect_simplify`, and
`260804_router_intelligence/000_master_plan.md:90` -> `260804_stacked_pr_ci`.
Both targets stay in `_plan/`; no edit needed.

## The authoritative edit list

Generated fresh against the final 12-unit move set, not diffed from an earlier
round:

```sh
for u in $(cat move-list); do
  rg -n "devlog/_plan/$u" . \
    --glob '!node_modules' --glob "!devlog/_plan/$u/**" \
    --glob '!devlog/_fin/260805_devlog_fin_sweep/**' --glob '!.git'
done
```

18 hits at generation time, in four groups. In a concurrently edited tree line
numbers drift, so the file path is authoritative and the line is a hint:

**Gates (2) — hand-edited:** `scripts/privacy-scan.ts:46`,
`tests/repo-hygiene.test.ts:156`.

**Source (2) — mechanical:** `src/providers/registry.ts:415`,
`src/cli/export-command.ts` (bare-name form, no edit — see below).

**Live devlog pointers (11) — mechanical:**
`260731_pr_landing_round/000_plan.md:34`,
`260730_prerelease_blockers/000_plan.md:4`,
`260804_router_intelligence/000_master_plan.md:89`,
`260802_triage_execution/000_research.md:4` (+ the `../` link at `:9`),
`260805_issue_pr_triage/001_prior_investigation_index.md:70,73`,
`260805_issue_pr_triage/030_cross_links.md`,
`260803_pr_issue_sweep/000_plan.md:100`,
`260803_pr_issue_sweep/040_phase4_backlog_disposition.md:122`,
`260804_stack7_service_vision/000_scope.md:7`.

**Historical records (2) — deliberately untouched:**
`260801_zero_leak_state_stores/070_close_and_push.md:117,119`,
`260731_macos_rss_retention/110_verify_and_push.md:14`.

Bare-name references (`devlog 260731_client_config_export/020`, and the
`src/cli/export-command.ts` / `gui/` / `tests/` comment headers that name the
unit without a `_plan/` prefix) need no edit: the directory name does not change,
only its parent. These were enumerated and checked, not assumed.
Two of these are historical statements rather than live pointers — the
selective-staging exclusion list in `260801_zero_leak_state_stores/070` and the
staging note in `260731_macos_rss_retention/110` describe what a past run
excluded from its index. Rewriting them would falsify a record of what happened.
They are left alone deliberately.

`260731_pr_landing_round/000_plan.md:34` was in that exempt group in the round-2
draft and does not belong there. Round 3 was right: it is not a staging record
but an active diagnosis telling the reader which file trips `privacy:scan`. A
reader following it needs it to resolve, so it gets repointed like any other live
pointer.

The rest are live pointers to where an answer lives, and they get repointed to
`devlog/_fin/`.

Note that several of these cite the unit by bare name rather than by path
(`devlog 260731_client_config_export/020`). Those need no edit — the name did
not change — but they were checked, not assumed.

Cross-unit `../` links: only `260802_triage_execution/000_research.md:9` crosses
the boundary. The `260803_integrations_toggle_all` <-> `260803_codex_desktop_toggle`
pair both stay in `_plan/`, so their `../` links keep resolving untouched.

## Order

1. `git mv` all 11.
2. Edit the two gate files by hand.
3. Rewrite the path references.
4. Fix the one cross-unit relative link
   (`260802_triage_execution/000_research.md:9`).
5. Verify: `repo-hygiene`, `privacy:scan`, gitlink check, `rg` for stale paths,
   count reconciliation against 53/295.

   The stale-path check excludes exactly three files by name, never a broad
   class, so a new stale reference anywhere else still fails the gate:

   - `devlog/_plan/260801_zero_leak_state_stores/070_close_and_push.md` and
     `devlog/_plan/260731_macos_rss_retention/110_verify_and_push.md` — historical
     records of what a past run excluded from its git index. Rewriting them would
     falsify what happened.
   - `devlog/_fin/260805_devlog_fin_sweep/020_move_execution.md` — this file.
     It is the execution record and necessarily quotes every pre-move path
     (audit r4). A check that did not exclude it would fail on its own `git mv`
     block forever.

   `260731_client_config_export` is no longer a moving unit, so the two
   historical records that name it need no exclusion on its account — they are
   excluded for the `260801_pr611_volcengine_evidence` line they also carry.
6. Commit — one commit, renames plus reference edits, so the rename detection
   stays readable in `git log --stat`.
