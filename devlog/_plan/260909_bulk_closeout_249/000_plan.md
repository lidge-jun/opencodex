# 000 — Plan and live manifest

Unit: `devlog/_plan/260909_bulk_closeout_249`. Session `01a081a4-9a6d-7c22-bbea-649653924329`.
Snapshot: 2026-09-09 (fetch), `origin/dev` = `7dc7dc99e`
(`Merge pull request #4037 from lidge-jun/codex/prs-stack-record`), dev version line 2.49.0,
latest release v2.48.0 (2026-09-08). Research worktree: `/tmp/ocx-249.xGQnxl/wt` (detached).

## Objective

Remove 25–30 open items (71 PRs + 69 issues at snapshot) from the live backlog by merging into
`dev` or closing with evidence, plus land the Bun 1.4.2 pin update. Maintainer constraints:

- Priority: (1) bug PRs/issues decidable without product judgment, (2) CI fixture and test
  determinism PRs already green, (3) small provider/compat fixes with no direction decision,
  (4) Bun 1.4.2 pin update as its own work-phase.
- No repository-wide local suite. Verifiers: focused `bun test tests/<domain>/<file>.test.ts`,
  `bun run typecheck`, `bun run test:changed`, exact-head hosted CI.
- Commit/push with `--no-verify`; Git mutations via `git -c core.hooksPath=/dev/null` when the
  postmerge hook would run installs or typecheck.
- Ordinary dependent PRs (manual chains, no GitHub native stacks), squash-merge bottom-up, admin
  merge on `dev` under MAINTAINERS.md. Carried or reimplemented contributor work keeps a
  `Co-authored-by` trailer.
- Subagents: `anthropic/claude-opus-5`, unlimited, read-only research lanes at P; independent
  reviewer at A.
- Out of scope: `main`/`preview` promotion, npm release, credential/account changes, feature PRs
  requiring product direction (#4022, #4020, #3833, #3810, #3901, #3952, #3458, #2462 …).

## Work-phase map (dependency-ordered, one PABCD cycle each)

Locked at wp0 D. Lane docs 001–005, 007, 008 are the research; 006 consolidates dispositions
and the conflict map; 010–060 are the per-work-phase execution docs; 070 is the ledger.

| WP | Scope | Doc |
|----|-------|-----|
| wp0 | Docs-only: manifest, lane research (001–005, 007, 008), dispositions (006), decade docs | 000–008 |
| wp1 | Stack A — luvs01 train, 9 PRs (#4041 #4015 #4012 #4014 #4004 #4039 #4043 #4034 #4006); wp1b #3997→#4025 gated on maintainer security review | 010 |
| wp2 | Stack B — other-author bug PRs, 7 (#4018 #4008 #3981 #3979 #3964 #3863 #3920); #4016 close is owned by wp5 | 020 |
| wp3 | Stack C — small non-bug PRs (#3980 #3897 #3963 #3984+test) + sponsor pair #3914→#3915 | 030 |
| wp4 | Bug-issue fixes, one PR each: #4032 #4035 #4023 #3807 | 040 |
| wp5 | CLOSE batch — issues #3994 #3989 #3464 #3320 #3245 #3266 #4001 #3255; PRs #4016 #2805 #2527 #2462 | 050 |
| wp6 | Bun 1.4.0 → 1.4.2 (package.json, Dockerfile digest, install-scripts.test.ts pin, bun.lock) + workflow drift | 060 |
| wp7 | Closeout: ledger reconciliation, removal count ≥25, unit to `_fin` | 070 |

wp1, wp2, wp3 are file-disjoint (006 conflict map) except the two hand-maintained test-layout
registries and the nine `gui/src/i18n/*.ts` files shared by #3863 (wp2) and #3914/#3915 (wp3);
those two items are serialized, never run concurrently. The stacks otherwise run in parallel
worktrees; wp5 is GitHub-only and
runs alongside any of them; wp4 touches only files no other stack touches but lands after
wp1/wp2 so fixture repairs are in place first; wp6 lands last and alone so a red lane is
attributable to the runtime change; wp7 last. Removable total per 006: 47 planned (33 without wp3/wp4/wp1b), against the 25–30 target.

## PR manifest (exact head at snapshot; 71 open)

Columns: head, mergeable, draft/ready, review, labels, +/-, files, check rollup at head.

| PR | Author | Head | Mergeable | State | Review | Labels | +/- | Files | Checks |
|----|--------|------|-----------|-------|--------|--------|-----|-------|--------|
| #4043 | luvs01 | a26f8bfe1 | MERGEABLE | draft | REVIEW_REQUIRED | bug | +195/-8 | 5 | SUCCESS:13 |
| #4042 | Vocllum | 320c20493 | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +1464/-44 | 14 | CANCELLED:1 SUCCESS:4 |
| #4041 | luvs01 | 9aa3e9204 | MERGEABLE | draft | REVIEW_REQUIRED | chore | +52/-11 | 1 | SUCCESS:13 |
| #4040 | cb8010d6 | b1d316501 | MERGEABLE | ready | REVIEW_REQUIRED | enhancement, review-ready | +166/-4 | 15 | CANCELLED:1 SUCCESS:14 |
| #4039 | luvs01 | 7ce4dac80 | MERGEABLE | ready | REVIEW_REQUIRED | bug, review-ready | +54/-1 | 4 | SUCCESS:17 |
| #4036 | luvs01 | a4a87b70f | MERGEABLE | draft | REVIEW_REQUIRED | bug | +91/-62 | 5 | CANCELLED:3 SUCCESS:13 |
| #4034 | luvs01 | eb835fe33 | MERGEABLE | ready | REVIEW_REQUIRED | bug, review-ready | +83/-26 | 11 | CANCELLED:1 SUCCESS:12 |
| #4033 | harryzhou2000 | 48e2ae5b3 | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +147/-1 | 13 | SUCCESS:5 |
| #4025 | luvs01 | 6c1387dc4 | MERGEABLE | draft | REVIEW_REQUIRED | bug, intake: hygiene-blocked | +553/-12 | 9 | CANCELLED:3 FAILURE:5 SUCCESS:8 |
| #4022 | rmsff | e54048a11 | MERGEABLE | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +35574/-340 | 175 | FAILURE:4 SUCCESS:5 |
| #4020 | alexalok | fece6ddda | MERGEABLE | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +1102/-59 | 56 | FAILURE:2 SUCCESS:3 |
| #4018 | cb8010d6 | d7387478b | MERGEABLE | draft | REVIEW_REQUIRED | bug, intake: hygiene-blocked | +50/-22 | 5 | FAILURE:5 SUCCESS:7 |
| #4016 | omarjson | 3cd59118a | MERGEABLE | draft | CHANGES_REQUESTED | bug | +46/-9 | 2 | CANCELLED:6 SUCCESS:16 |
| #4015 | luvs01 | 4141281b1 | MERGEABLE | ready | REVIEW_REQUIRED | chore, review-ready | +128/-27 | 2 | SUCCESS:20 |
| #4014 | luvs01 | 50929c100 | MERGEABLE | ready | REVIEW_REQUIRED | chore, review-ready | +178/-136 | 1 | SUCCESS:13 |
| #4012 | luvs01 | 59a390c74 | MERGEABLE | ready | APPROVED | chore, review-ready | +14/-22 | 1 | FAILURE:1 SUCCESS:12 |
| #4008 | cb8010d6 | 522e438f5 | MERGEABLE | draft | REVIEW_REQUIRED | bug | +47/-1 | 2 | SUCCESS:13 |
| #4006 | luvs01 | ffdd70556 | MERGEABLE | draft | REVIEW_REQUIRED | bug | +402/-54 | 17 | CANCELLED:2 SUCCESS:18 |
| #4004 | luvs01 | 9809dc4d6 | MERGEABLE | ready | APPROVED | chore, review-ready | +106/-19 | 1 | SUCCESS:17 |
| #3997 | luvs01 | 094e509f0 | MERGEABLE | draft | REVIEW_REQUIRED | bug, intake: hygiene-blocked | +88/-1 | 5 | FAILURE:8 SUCCESS:9 |
| #3987 | cb8010d6 | f3247298b | MERGEABLE | ready | REVIEW_REQUIRED | enhancement, review-ready | +387/-29 | 25 | CANCELLED:1 SUCCESS:14 |
| #3984 | yansigit | 35a4d99d6 | MERGEABLE | draft | REVIEW_REQUIRED | chore, intake: hygiene-blocked | +3/-3 | 2 | FAILURE:2 SUCCESS:3 |
| #3983 | yansigit | dc7ce1f79 | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +537/-23 | 11 | SUCCESS:5 |
| #3982 | yansigit | 239868dde | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +370/-47 | 15 | CANCELLED:2 SUCCESS:7 |
| #3981 | yansigit | 9f666b33a | MERGEABLE | draft | REVIEW_REQUIRED | bug | +70/-2 | 4 | SUCCESS:5 |
| #3980 | yansigit | b855765dd | MERGEABLE | draft | REVIEW_REQUIRED | chore | +12/-6 | 1 | SUCCESS:5 |
| #3979 | yansigit | b8c92f2e5 | MERGEABLE | draft | REVIEW_REQUIRED | bug | +9/-2 | 2 | SUCCESS:5 |
| #3964 | ildunari | 8488a47c8 | MERGEABLE | ready | REVIEW_REQUIRED | bug, review-ready | +45/-9 | 3 | SUCCESS:9 |
| #3963 | luvs01 | 5497cd994 | MERGEABLE | draft | REVIEW_REQUIRED | documentation | +31/-2449 | 62 | CANCELLED:2 SUCCESS:10 |
| #3954 | omarjson | 8b90fbfbb | MERGEABLE | ready | CHANGES_REQUESTED | bug, review-ready | +128/-8 | 2 | CANCELLED:6 SUCCESS:15 |
| #3952 | yxr1995-maker | 210e311d7 | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +467/-11 | 9 | SUCCESS:15 |
| #3920 | cb8010d6 | 3c3ca0aac | MERGEABLE | draft | REVIEW_REQUIRED | bug | +459/-9 | 21 | SUCCESS:12 |
| #3915 | lidge-jun | 95253b8f0 | CONFLICTING | ready | REVIEW_REQUIRED | enhancement | +505/-20 | 36 | CANCELLED:4 SKIPPED:2 SUCCESS:35 |
| #3914 | lidge-jun | 713ce6b02 | CONFLICTING | ready | REVIEW_REQUIRED | enhancement | +470/-19 | 33 | CANCELLED:3 SKIPPED:2 SUCCESS:36 |
| #3901 | jingzxy | 7fd3a1c89 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +802/-9 | 16 | FAILURE:6 SUCCESS:7 |
| #3897 | parkjs101 | 356f2c1db | MERGEABLE | draft | REVIEW_REQUIRED | chore | +117/-8 | 8 | SUCCESS:13 |
| #3863 | x3M3x | 51e544ad9 | MERGEABLE | ready | REVIEW_REQUIRED | bug, review-ready, landed-via-maintainer | +208/-64 | 16 | SUCCESS:13 |
| #3848 | shaun0927 | cb28a097f | CONFLICTING | draft | REVIEW_REQUIRED | bug, intake: hygiene-blocked | +1122/-127 | 63 | CANCELLED:1 FAILURE:14 SUCCESS:16 |
| #3833 | rrmlima | 6605ed19c | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +256/-4 | 9 | CANCELLED:4 SUCCESS:24 |
| #3810 | waxiangzi | d61d16ea7 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +69403/-126 | 332 | CANCELLED:1 FAILURE:1 SUCCESS:3 |
| #3748 | yansigit | 5b1cbbcb3 | MERGEABLE | ready | REVIEW_REQUIRED | enhancement, review-ready | +642/-0 | 8 | CANCELLED:1 SUCCESS:10 |
| #3742 | yansigit | 3e6be56f3 | MERGEABLE | ready | REVIEW_REQUIRED | enhancement, review-ready | +784/-49 | 4 | SUCCESS:9 |
| #3741 | yansigit | 0d38947ed | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +354/-1 | 14 | FAILURE:2 SUCCESS:3 |
| #3738 | y2ambition-ai | 4e7ea1903 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +2505/-77 | 29 | CANCELLED:1 FAILURE:5 SUCCESS:7 |
| #3709 | sbrusse-git | 81787552a | MERGEABLE | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +222/-10 | 11 | FAILURE:2 SUCCESS:3 |
| #3663 | y2ambition-ai | 8e0b53b0f | CONFLICTING | draft | REVIEW_REQUIRED | enhancement | +1249/-15 | 19 | SUCCESS:9 |
| #3652 | itismyfield | 13fb26377 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement | +243/-11 | 14 | SUCCESS:5 |
| #3648 | Muki182 | bd3644333 | MERGEABLE | draft | REVIEW_REQUIRED | documentation | +309/-0 | 6 | CANCELLED:2 SUCCESS:2 |
| #3639 | chrisoro | 6a9fde4ec | MERGEABLE | draft | REVIEW_REQUIRED | intake: hygiene-blocked | +590/-62 | 39 | CANCELLED:4 FAILURE:8 SUCCESS:10 |
| #3463 | drakonkat | 3e0439cfe | MERGEABLE | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +871/-3 | 14 | FAILURE:6 SUCCESS:7 |
| #3458 | Ingwannu | ba6f822ca | CONFLICTING | draft | REVIEW_REQUIRED | enhancement | +15547/-14 | 99 | SKIPPED:1 SUCCESS:33 |
| #3389 | Yum-wu | 12501543a | MERGEABLE | draft | REVIEW_REQUIRED | enhancement | +464/-3 | 4 | SUCCESS:5 |
| #3283 | vanch007 | 34b1f4a4a | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +960/-53 | 14 | CANCELLED:1 FAILURE:1 SUCCESS:3 |
| #3282 | Simon-Opopeee | 351d8ce04 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +521/-14 | 39 | FAILURE:4 SUCCESS:5 |
| #3080 | x3M3x | 3e8b06e26 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +812/-41 | 10 | FAILURE:2 SUCCESS:3 |
| #3025 | randomix777 | 7d392541d | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +3461/-59 | 37 | FAILURE:2 SUCCESS:3 |
| #2921 | Warexpor | 54e315b82 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement | +1573/-98 | 36 | SUCCESS:5 |
| #2881 | wonny-log | 9487879e7 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +985/-101 | 51 | CANCELLED:2 FAILURE:3 SUCCESS:6 |
| #2805 | Ingwannu | 2e1a0a9d6 | CONFLICTING | ready | REVIEW_REQUIRED | chore, maintainer-sponsored, gui-screenshot-waived | +3196/-3060 | 23 | SKIPPED:1 SUCCESS:39 |
| #2562 | roy6732856 | 4bab2fbbc | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +4031/-248 | 46 | FAILURE:3 SKIPPED:1 SUCCESS:23 |
| #2527 | harryzhou2000 | a0f35833d | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +1983/-58 | 19 | CANCELLED:1 FAILURE:4 SUCCESS:6 |
| #2462 | kwannz | 049d55605 | CONFLICTING | draft | REVIEW_REQUIRED | enhancement, intake: hygiene-blocked | +9542/-798 | 95 | FAILURE:3 SKIPPED:1 SUCCESS:26 |
| #2366 | chilung-cgu | 309aa29ef | CONFLICTING | draft | CHANGES_REQUESTED | enhancement | +741/-12 | 8 | SUCCESS:5 |
| #2362 | chilung-cgu | 20ca9f240 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +839/-5 | 11 | CANCELLED:2 FAILURE:2 SUCCESS:4 |
| #2355 | harryzhou2000 | ec0c68dac | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +1110/-17 | 28 | FAILURE:4 SUCCESS:5 |
| #2351 | harryzhou2000 | b0986b175 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +2817/-150 | 42 | CANCELLED:1 FAILURE:4 SUCCESS:6 |
| #2280 | cristph | 6f129c196 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement | +553/-15 | 17 | SUCCESS:19 |
| #2244 | ZSN12 | 767843666 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +913/-0 | 9 | FAILURE:2 SUCCESS:3 |
| #2230 | ppvia | 93c0110de | CONFLICTING | draft | CHANGES_REQUESTED | enhancement, intake: hygiene-blocked | +1637/-61 | 33 | FAILURE:2 SUCCESS:3 |
| #2213 | louis-tepe | 227f89d72 | CONFLICTING | draft | CHANGES_REQUESTED | enhancement | +510/-98 | 18 | FAILURE:5 SKIPPED:1 SUCCESS:18 |
| #1645 | waw4303 | 2a760080b | CONFLICTING | draft | CHANGES_REQUESTED | enhancement | +1425/-151 | 68 | CANCELLED:1 SKIPPED:1 SUCCESS:31 |

## Issue manifest (69 open)

| Issue | Author | Opened | Labels | Title |
|-------|--------|--------|--------|-------|
| #4038 | cb8010d6 | 2026-09-08 | enhancement, gui | Show estimated decode tok/s alongside end-to-end throughput in Logs |
| #4035 | h-dot-seo | 2026-09-08 | bug, cli, service | [Bug]: Codex App update invalidates the persisted codex-runtime.json pin — the dead hashed |
| #4032 | tizerluo | 2026-09-08 | bug, catalog, platform, service | Chained clients (provider hub) drop per-model context windows the hub already serves — eve |
| #4024 | nordz0r | 2026-09-08 | enhancement, provider, account-pool | [Feature]: OpenRouter — automatic key rotation & model failover when the free-tier quota i |
| #4023 | tommy1616 | 2026-09-08 | bug, gui, platform, service | [Bug][macOS][Dashboard] Stop button can unload launchd service before native Codex teardow |
| #4017 | cb8010d6 | 2026-09-08 | bug, account-pool | Pro Spark five-hour quota is shown as a generic account window |
| #4007 | cb8010d6 | 2026-09-08 | bug, account-pool | Spark quota disappears after partial response-header updates |
| #4005 | luvs01 | 2026-09-08 | bug | Hashless Codex journal can overwrite later settings and become trusted on reinjection |
| #4003 | luvs01 | 2026-09-08 | bug | Client transaction test fixture has no child timeout or failure cleanup |
| #4001 | lidge-jun | 2026-09-08 | account-pool | chore: Cockpit Tools Antigravity import를 2급(비공식) 지원으로 검토 |
| #3996 | luvs01 | 2026-09-08 | bug, account-pool | Fresh requests can reject a cooled-down Pool before using their valid main credential |
| #3994 | FacuM | 2026-09-08 | bug, account-pool | [Bug]: 2.42.0 Plus quota exhaustion causes 18 incomplete failures without switching to mai |
| #3989 | rrmlima | 2026-09-08 | bug, account-pool, gui | Hermes integration treats external config changes as whole-file conflicts and risks destru |
| #3978 | cb8010d6 | 2026-09-08 | enhancement | [Feature]: opt into Codex client compaction without disabling V2 routing |
| #3958 | rrmlima | 2026-09-07 | enhancement, account-pool | [Feature]: opt-in 900k extended context aliases for eligible native OpenAI/Codex OAuth mod |
| #3926 | DaveW001 | 2026-09-07 | provider-compatibility, provider | Google AI Studio model discovery rejects native models[] envelope |
| #3916 | cb8010d6 | 2026-09-07 | bug, service | Codex restore leaves ocx1-compacted threads unreplayable on the native backend |
| #3898 | nordz0r | 2026-09-07 | enhancement, account-pool | Headless hub: WebUI cannot reauth native main (deviceauth is pool-only) |
| #3894 | parkjs101 | 2026-09-07 | enhancement, proxy | Remove the direct router and API-key-selection import cycle |
| #3859 | nordz0r | 2026-09-07 | enhancement, account-pool, gui, proxy | [Feature]: Option to toggle or disable email masking for stored accounts in Dashboard and  |
| #3846 | shaun0927 | 2026-09-07 | bug, account-pool | [Bug]: Codex pool registration couples account persistence to warmup success |
| #3807 | DaveW001 | 2026-09-06 | bug, proxy | [Bug] 2.43.0 unpaired-tool-result guard rejects Codex desktop sub-agent seed shape: every  |
| #3782 | ZhenyuXiao | 2026-09-06 | bug | [Bug]: Claude Desktop 1.46388.4 cannot switch models within an active conversation |
| #3781 | jaychou0642-create | 2026-09-06 | bug, account-pool | [Bug]: Antigravity quota refresh failure — investigate missing canonical Fake-IP handling |
| #3777 | practical-tools-lab | 2026-09-06 | enhancement, account-pool | [Feature]: expose the Anthropic account subscription tier (plan) like the OpenAI provider  |
| #3775 | leonclab | 2026-09-06 | bug, catalog | [Bug] Codex 0.153.4 rejects 'minimal'/'none' on gpt-6-astra mapped custom models |
| #3774 | leonclab | 2026-09-06 | enhancement, gui | [Feature] Allow visual drag-and-drop reordering for modelPickerOrder in Web GUI |
| #3765 | alexph-dev | 2026-09-06 | bug, tools | [Bug]: Claude Messages to Astra cache plateau/reset with growing history; Codex CLI compar |
| #3761 | foo1maker | 2026-09-06 | provider-compatibility, provider, streaming, tools | [Provider compatibility] Ollama Cloud Responses passthrough skips web-search sidecar; host |
| #3729 | rrmlima | 2026-09-06 | enhancement, catalog | feat(codex): pull an authenticated remote catalog into local Codex state |
| #3719 | lidge-jun | 2026-09-05 | bug, proxy | Bug: preserve Anthropic thinking replay through proxy-auth translation and clarify prompt- |
| #3705 | rmsff | 2026-09-05 | enhancement, proxy, streaming, tools | [Feature]: add opt-in sensitive-data Guardrails |
| #3675 | DamnUi | 2026-09-05 | bug, proxy | accept 413 gracefully |
| #3666 | nordz0r | 2026-09-05 | enhancement, catalog, gui | [Feature]: Filter free models in Dashboard catalog (OpenRouter, KiloCode, etc.) |
| #3661 | Hu9956 | 2026-09-05 | bug, proxy, platform | unreadable_encrypted_agent_task intermittently fails routed V2 subagent dispatch (strict r |
| #3657 | Ingwannu | 2026-09-05 | bug, streaming | [Bug]: Intermittent Astra native stream failures lack actionable error evidence |
| #3630 | doublewater777 | 2026-09-05 | enhancement, catalog, cli | [Feature]: Periodic auto-refresh of provider model catalog (pick up newly released models  |
| #3573 | nowhere1975 | 2026-09-05 | enhancement, proxy | Feature: configurable inbound body limit - 922k context sessions 413 on remote compact (25 |
| #3522 | stephen-drew | 2026-09-04 | bug, platform | [Bug][Windows] Continuation spill failures accumulate behind healthy readiness after #3011 |
| #3506 | stephen-drew | 2026-09-04 | bug, upstream-tracking, streaming, tools | [Bug] Cursor/Grok 4.6 no-progress loop persists on OpenCodex 2.42.0 after #2600 |
| #3494 | str0203 | 2026-09-04 | enhancement, platform, tools | Feature request: Extend existing integrations to AI agents running in VS Code |
| #3464 | garysassano | 2026-09-04 | bug, platform, service | mise upgrade leaves launchd proxy running an old OpenCodex version |
| #3459 | drakonkat | 2026-09-04 | enhancement, provider | [Feature]: Pre-adapter request transform hook (custom handlers on OcxParsedRequest) |
| #3433 | Vivamisu | 2026-09-04 | bug, provider, proxy | [Bug]: Intermittent consecutive zero cache hits for Hermes requests through OpenCodeX |
| #3417 | luvs01 | 2026-09-04 | enhancement, gui | feat(gui): expose native main login profiles in the WebUI |
| #3379 | lidge-jun | 2026-09-03 | enhancement, gui | [Feature]: dashboard management gaps — delete rollback entries, custom usage ranges, renam |
| #3377 | lidge-jun | 2026-09-03 | enhancement, provider | [Feature]: per-model capability declarations — text-only, context tier, and video processi |
| #3376 | lidge-jun | 2026-09-03 | enhancement, account-pool, platform | [Feature]: retain quota history and make reset windows a scheduling input (capacity estima |
| #3375 | lidge-jun | 2026-09-03 | enhancement, account-pool | [Feature]: complete the OAuth account-pool lifecycle — session affinity, 401/403 rotation, |
| #3320 | chowyuan1314 | 2026-09-03 | bug, needs-info, platform, service | Windows: v2.40.0 still misclassifies a valid scheduler task for non-ASCII account names |
| #3266 | Veritas-7 | 2026-09-02 | enhancement, proxy | feat(combo): per-combo attempt first-byte deadline so a stalled target hops before the glo |
| #3255 | str0203 | 2026-09-02 | enhancement, needs-info, catalog | [Bug] Decouple model capability and response speed controls to match the official OpenAI C |
| #3245 | Vontean | 2026-09-02 | bug, upstream-tracking, needs-info, cli, platform, streaming, service | [Bug][Codex] macOS Codex 0.152.0 streams disconnect through ocx 2.39.0 |
| #3191 | SOSANA | 2026-09-01 | enhancement, provider, account-pool, tools | [Feature]: add Muse Code subscription routing through a process-backed MSP adapter |
| #2894 | nordz0r | 2026-08-29 | enhancement, account-pool | [Feature] SOCKS5 proxy support for outbound provider calls - and fail fast on unsupported  |
| #2834 | str0203 | 2026-08-28 | enhancement, provider | [Feature] Add relay model diagnostics for connectivity, latency, and identity consistency |
| #2811 | luvs01 | 2026-08-28 | enhancement, proxy | Feature: provenance-aware Codex CLI update manager |
| #2730 | canbetry | 2026-08-27 | enhancement, account-pool, tools | [Feature]: Allow /v1/alpha/search to use a configured web-search backend without ChatGPT f |
| #2511 | NotWizard | 2026-08-25 | enhancement, provider, proxy | Feature: opt-in per-provider request byte budget that downscales then prunes inline images |
| #2495 | Sigurd-git | 2026-08-24 | enhancement, proxy, streaming, tools, service | Feature: opt-in plaintext V2 collaboration rewrite for native-to-routed sub-agents |


## Research lanes (claude-opus-5, read-only, parallel)

| Doc | Lane | Items |
|-----|------|-------|
| 001 | bug PRs A (luvs01 train) | #4043 #4041 #4039 #4036 #4034 #4025 #4015 #4014 #4012 #4006 #4004 #3997 (+ issues #4003 #4005 #3996) |
| 002 | bug/compat PRs B | #4018 #4016 #4008 #3981 #3979 #3964 #3954 #3920 #3863 #3848 (+ issues #4017 #4007 #3916 #3846) |
| 003 | small non-bug PRs | #3980 #3984 #3963 #3897 #3648 #3748 #3742 #4040 #3987 #4033 #4042 #3983 #3982 (+ issues #4038 #3978 #3894) |
| 004 | bug issues | #4035 #4032 #4023 #3994 #3989 #3807 #3782 #3781 #3775 #3765 #3761 #3926 #3719 #3675 #3661 #3657 #3522 #3506 #3464 #3433 #3320 #3245 |
| 005 | feature issues + large/stale PRs | 31 enhancement issues; 25 feature PRs incl. #3915/#3914 |
| 007 | Bun 1.4.2 update design | package.json, @types/bun, Dockerfile, workflows, lock, docs |
| 008 | stale tail (oldest) | PRs #2527 #2462 #2366 #2362 #2355 #2351 #2280 #2244 #2230 #2213 #1645; issues #2455 #2358 #2279 #1811 #1782 #1711 #1416 #1213 #95 |

Dispositions are consolidated in `006_dispositions.md`; decade docs `010`–`070` are the
diff-level plans for wp1–wp7.

## Bun 1.4.2 facts (verified at P)

- `npm view bun@1.4.2 version` → `1.4.2`; `gh release view bun-v1.4.2 --repo oven-sh/bun` →
  published 2026-09-05T05:55:48Z.
- Current pins on dev: `package.json` dependencies `"bun": "1.4.0"`, devDependencies
  `"@types/bun": "1.4.0"`; `Dockerfile:4` `ARG BUN_IMAGE=oven/bun:1.4.0@sha256:5ff6093…`;
  `.github/workflows/cleanup-orphaned-workflows.yml:40` `bun-version: 1.3.14`; local
  `bun --version` = 1.4.0. Full file list and lock hunk in 007.

## Verifiers (PLAN-VERIFIER-REAL-01)

- `bun run typecheck` — exit 0 on current dev (run in a scratch worktree at each P).
- `bun test tests/<domain>/<file>.test.ts` — named per landing in the decade docs.
- `gh pr checks <n>` filtered to the exact head SHA — hosted CI; skipped/cancelled ≠ pass.
- `git fetch origin dev && git merge-base --is-ancestor <sha> FETCH_HEAD` — landing proof.
- `bun run privacy:scan` — exit 0 on every devlog commit.

## HOTL resource bounds (this cycle)

Tools: `gh` read-only + `git` read-only against origin; writes limited to
`devlog/_plan/260909_bulk_closeout_249/` and `.codexclaw/`. Subagents: opus-5 read-only lanes plus
one reviewer. Wall-clock bound for wp0: 90 minutes from P entry. No push/merge/close in wp0.



## wp0 D record (2026-09-09, session 01a081a4-9a6d-7c22-bbea-649653924329)

Conclusion: roadmap locked. 47 removable items are enumerated in 006 (24 PR merges, 12 closes,
7 issues closed by merges, 4 bounded issue fixes); the floor with only wp1 + wp2 + wp5 is 33,
above the 25–30 target. Independent audit (opus-5) returned NEAR-PASS with no blockers; residuals
R1/R3/R4/R5/R6/R8 were folded in place, R7 (noreply trailers) and R9 (#3920 `Closes #3916`)
are execution-time decisions recorded in 006. Check: `bun run privacy:scan` exit 0 on the
roadmap commit, receipt-bound; all sixteen numbered docs present.

What did not hold from the P-phase assumptions: lane C's "small non-bug" bucket and lane E/G's
"already shipped" bucket were both nearly empty; the real volume is the luvs01 train (wp1), the
other-author bug PRs (wp2), and evidence-backed closes (wp5). No contributor PR has a
`ci.yml` run at head (fork approval gate), so every LAND is conditional on a maintainer
workflow approval or a maintainer carry branch. `gh pr diff | git apply` fails on binary
screenshots (use `refs/pull/N/head` + `merge --squash`). The test-layout registries have no
regeneration command and are hand-maintained. The 007 workflow-drift suggestion would have
broken `cleanup-orphaned-workflows.test.ts`; 060 uses the literal version.

Evidence that this direction is wrong would be: a hosted `ci.yml` run at a wp1/wp2 carry head
failing on Linux/Windows for a PR whose focused tests passed locally under Bun 1.4.0 — that
would mean the local focused runs are not predictive and each stack needs per-item dispatch
before the next item is stacked.

Next: wp1 (010), wp2 (020), wp3 (030), wp5 (050) can start in parallel worktrees once the
maintainer authorizes execution; wp1b and wp5 posting stay gated on the human decisions named
in 070. Roadmap branch: `codex/260909-bulk-closeout-roadmap` (local, not pushed).

