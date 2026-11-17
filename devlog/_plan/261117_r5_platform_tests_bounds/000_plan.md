# R5 platform, test-hygiene and resource-bound triage (2026-11-17)

Lane `R5-platform-tests-bounds`, branch `triage/r5-platform-tests-bounds`, base `origin/dev`
at `c36793a9336b70cfe5bc3b7f6e6f751e730fb6fc`. One branch, ordered commits, one PR to `dev`.
The coordinator merges; this lane does not merge, comment on, or push to other pull requests.

## Objective

Classify fourteen items as MERGE-READY, CARRY or DEFER against the base, implement every CARRY
as its own commit with a regression test that fails before the change, and open one lane PR.
Platform bugs and #8848 come first.

## Constraints

- macOS host. Windows behavior is proven with platform-faked unit tests; real Windows execution
  is NOT RUN and is covered by the coordinator's batch `lane=all` run after merging.
- File-size ratchet (`tests/fixtures/file-size-baseline.json`), test-layout registration,
  structure ownership (`bun run structure:check`) and `privacy:scan` apply to every commit.
- Security findings for unfixed defects stay in `.tmp/`; nothing here is pre-disclosure
  material (every item below is a public issue or pull request).

## Triage matrix

| Item | Kind | Classification | Reason |
|---|---|---|---|
| #8863 zh-CN schtasks status | issue | CARRY (wp2) | `parseTaskCsvState` (src/service/windows-checked-stop-live.ts:125) accepts English words only; the PowerShell fallback cannot finish inside the 1 s `managerState` cap. Recognize the status words observed from shipped resources (zh-CN, ko-KR). |
| #8697 IPv4 loopback timeout | issue | DEFER | The proposed bind fallback on loopback contradicts the #8318 refusal-only rule in `provenFreeByBind` (src/server/proxy-liveness.ts:472): on BSD-style stacks a specific bind can succeed beside a wildcard listener, and a listener with a full backlog can also time out. A safe design (exclusive bind of both the specific loopback address and the family wildcard) changes two ownership fences and depends on Windows bind semantics that need native evidence; that is a maintainer design decision. |
| #8865 Windows-absolute model_catalog_json | issue | DEFER | Correct fix rewrites the generated binding on every install and the journaled restore paths (`catalog/restore.ts:76` reads the journal path cwd-relative); needs a maintainer decision on platform scope and journal migration. Design in 040. |
| #8848 fixture credentials to real hosts | issue | CARRY (wp5) | Confirmed on this host (chatgpt.com wss, wham/usage, auth.openai.com/oauth/token, api.githubcopilot.com via node:https). A preload egress guard refuses non-local targets; leaking files that depend on the real answer get seams. |
| #8852 host-install dependent suites | issue | DEFER | Five suites read ambient host process and install state; each needs its own isolation seam and a host that reproduces it. Not bounded for this lane. |
| #8853 server suites time out under load | issue | DEFER | `tests/helpers/test-budget.ts` forbids raising a budget unless the wait is intrinsic; server-images and server-search are in the #8848 leak set (chatgpt.com wss), so re-measure after the guard lands. |
| #8817 [draft] Windows stop owner filter | PR | decided in wp6 | C4 (termination authority). Needs an independent security review before any carry; the author still marks it draft pending maintainer security review and a Windows run of its new PowerShell cases. |
| #8746 [draft] /dev/null git config on Windows | PR | CARRY (wp3) | Test-only, sound; Git for Windows 2.56 rejects `NUL`. Carried with author credit. |
| #8851 MCP wait bound barrier | PR | MERGE-READY | head 35200782988a; test-only; independent review on the merged tree: 15 pass, typecheck clean. |
| #8834 link post-proof fixtures | PR | MERGE-READY | head 0fbc43b8f086; test-only; 26 pass on merged tree. |
| #8800 usage cooperative decoding | PR | MERGE-READY | head 1743a9314768; 186 pass on merged tree; new cases fail on base. |
| #8801 ocx-child WS event retention | PR | MERGE-READY | head bf259f16c346; cargo lib 57 pass, feature-gated 56 + 5 integration pass. |
| #8804 kiro linear catalog admission | PR | MERGE-READY | head 6d0cf4653d56; 77 pass; new cases fail on base. |
| #8810 eager catalog diagnostic budget | PR | MERGE-READY (security check of its mask-test rewrite in flight) | head f50f78a503e1; 161 pass; new cases fail on base. |

## Work-phase map (dependency order)

| Work phase | Doc | Content |
|---|---|---|
| wp1 | this file | roadmap and triage (docs only) |
| wp2 | 010_phase1_8863_schtasks_locale.md | #8863 |
| wp3 | 030_phase3_8746_git_null_config.md | carry #8746; #8697 stays DEFER (recorded above) |
| wp4 | 040_phase4_8865_catalog_binding.md | #8865 deferral design record (docs only) |
| wp5 | 050_phase5_8848_test_egress_guard.md | #8848 |
| wp6 | 060_phase6_pr_carries.md | #8817 and any PR the review returns as NOT-READY but carryable |
| wp7 | 070_phase7_lane_pr.md | verification, lane PR, exact-head checks, report |


