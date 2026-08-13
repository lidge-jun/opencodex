# 002 — Disposition matrix

Cutoff: 2026-08-13. Classes are main-session judgments after live read + subagent deep-reads.
Evidence snippets are public issue/PR text only.

## A. Active product bugs (prioritizable)

| # | Class | Pri | Area | Plain symptom | Evidence quality | Fixability | Related PR / note |
|---:|---|---|---|---|---|---|---|
| 1599 | BUG | P1 | service/macOS | launchd/`ocx start` crash-loops on OpenAI-tier backup collision; port never binds | high (stack + path contrast vs init cleanup) | partial (design: preserve-then-continue) | no PR yet |
| 1589 | BUG | P1 | Windows identity | Bun + PowerShell `-WindowStyle Hidden` exit 255 → identity refusal blocks config/sync | high | ready | related open #1279 history; drop CLI flag, keep `windowsHide` |
| 1573 | BUG | P1 | Windows locale | Korean/non-ASCII profile path decoded as UTF-8 → U+FFFD; service ownership + sync fail | high | ready | contributor codec fallback validated; no PR number yet |
| 1571 | BUG | P1 | provider/volcengine | tool-call continuation 400 on Coding Plan empty assistant content (regression) | high | ready | **#1574** draft closes it; #1570 duplicate |
| 1544 | BUG | P1 | provider/deepseek tools | undeclared top-level `apply_patch` aborts routed CodeModeOnly turns | high | ready | **#1576** ready, CI green |
| 1527 | BUG | P1 | Cursor adapter | large-context turns collapse/429 via OCX while direct Cursor healthy | high comparative | partial (needs wire contract) | no fix PR |
| 1483 | NEEDS-INFO / partial | P1 | Xiaomi MiMo | remaining invalid tool-call stream after ladder fix | high for ladder, incomplete for frames | blocked on shape capture | ladder fixed by merged #1485 |
| 1419 | NEEDS-INFO | P1 | macOS service | Bun SIGTRAP after TLS/reset; unsupervised proxy stays dead | med | blocked on `.ips` frames | #1539 adjacent only |
| 1302 | BUG | P1 | CI runtime | intermittent hang / orphan bun; event-loop spin evidence | very high | hard | no fix PR; not timeout-only |
| 1592 | BUG | P2 | xAI catalog | grok-4.6 `xhigh` clamped to `high` | high | ready | **#1593** review-ready closes #1592; **#1591** overlaps |
| 1587 | LIKELY-BUG | P2 | catalog cost | routed first-turn tools 3–5× native Sol tokens | high measurements | design | not a one-liner |
| 1582 | BUG | P2 | openai-chat baseUrl | doubled `/chat/completions` → 404 | high | ready | local branch noted; open PR not yet listed in open set |
| 1580 | LIKELY-BUG | P2 | usage GUI | previous-day totals shrink over time | med screenshots | needs-info root cause | no PR |
| 1562 | BUG | P2 | GUI V2 | silent fail when `codex` ENOENT | high | ready (surface error) | no PR |
| 1524 | ARCHITECTURE / policy | P2 | routing fallback | fallback can pick routes that cannot accept context/modality | med design | design | capability preflight |
| 1296 | LIKELY-BUG residual | P2 | Windows ACL class | ACL harden failures historically shown as `401 authentication_error` | high historical / unproven current path | partial | do not invent synthetic repro |
| 1024 | BUG residual | P2 | custom vision | ambiguous vision capability when model metadata missing (TokenRouter residual) | med | partial | narrowed scope in issue body |
| 1049 | BUG / hardening | P2 | codex home coord | pre-substrate homes still outside write coordinator | high design | partial | multi-process safety debt |
| 1059 | BUG / CI program | P2 | Windows CI | full Windows suite still dispatch-only | high process | long-running | burn-down tracker |
| 1585 | BUG (capability) | P2 | command-code | Muse Spark reasoning efforts not advertised though accepted upstream | high | ready | **#1585** review-ready |
| 1583 | BUG | P2 | Cursor tools | `wait` can remain after exec creator truncated → exec cell loops | high | ready | **#1583** draft review-ready |
| 1597 | BUG | P2 | responses cache | continuation replay not scoped to client task; stale foreign previous_response_id | high | ready | **#1597** draft |
| 1581 | BUG | P3 | GUI | right-side Select dropdown overflows viewport | high | ready | **#1581** draft |
| 1579 | BUG | P2* | credentials | provider delete leaves OAuth credentials | high intent | blocked hygiene | **#1579** hygiene-blocked |
| 1412 | BUG / guard | P2 | responses size | oversized replayed history can balloon/crash path | med-high | large draft risk | **#1412** huge draft |
| 1563 | BUG (CI flake) | P3 | CI macOS | native-profile busy probe flakes ~6s on hosted macOS | high | ready | **#1575** closes it |
| 1533 | NOT-BUG (UX) | P3 | GUI copy | needs better native→routed V2 explanation; transport is #92 | med | docs/UX | not a runtime defect |
| 1478 | ARCHITECTURE | P3 | config rebase | deletion vs unseen-key provenance | high design / no live break | design | roadmap |
| 1594 | BUG report / weak | P3 | deepseek | reasoning_text must be passed back — thin report | low | unclear | #1534/#906/#1499 already closed; treat carefully, not second root cause without fresh capture |
| 1570 | DUPLICATE | P3 | volcengine | same as #1571 | high | via #1571 | close as duplicate of #1571 when convenient |
| 1388 | UPSTREAM | P3/P4 | Cursor apply | exact-match drift after valid conversion | med | low in OCX | host apply semantics |
| 904 | NEEDS-INFO | P3 | encoding | Korean file write U+FFFD; wire paths already clean | low remaining | blocked | needs failing capture |
| 417 | UPSTREAM TRACKING | P4 | voice | Korean realtime transcript U+FFFD | high elimination of OCX | external | openai/codex tracking |
| 92 | UPSTREAM TRACKING | P4 | V2 encrypted task | NEW_TASK body loss across providers | high | mitigation opt-in landed | experimental recovery exists |

\*P2 if hygiene unblocked; currently not reviewable.

## B. Open fix PR dispositions

| PR | Class/role | Draft | Ready signal | CI/hygiene | Linked issue | Review priority | Note |
|---:|---|---|---|---|---|---|---|
| 1576 | fix | no | strong | green matrix at cutoff | #1544 | **R1** | undeclared tool reject; best merge candidate |
| 1593 | fix | no | review-ready | hygiene/enforce green | #1592 | **R1** | narrow xAI ladder; prefer over broader overlap |
| 1575 | chore/test | no | strong | green | #1563 | **R2** | tiny flake bound |
| 1585 | fix | no | review-ready | green | (muse spark) | **R2** | small capability advertise |
| 1591 | fix | no | review-ready | green-ish | overlaps #1592 | **R2** | broader than #1593 (Cursor Fast too); pick one strategy |
| 1574 | fix | yes | draft | tests green in rollup | #1571 | **R2** | needs ready-for-review after final check |
| 1583 | fix | yes | review-ready label | draft still | Cursor exec pin | **R2** | draft but labeled review-ready |
| 1597 | fix | yes | draft | partial checks | continuation scope | **R3** | important isolation; still draft |
| 1581 | fix | yes | draft | early checks | GUI overflow | **R3** | low severity UI |
| 1579 | fix | yes | hygiene-blocked | hygiene/enforce FAIL | credential delete | **R4** blocked | do not review until intake clean |
| 1412 | fix | yes | large draft | early checks | oversized input | **R4** careful | +2685/-106; high blast review cost |
| 1600 | chore | no | failing | macos/ci FAIL | CI timeouts | **R4** | not a product bug fix; red at cutoff |

## C. Ranking rationale examples (evidence anchors)

### #1599 service crash-loop
Issue body names `OpenAiTierBackupCollisionError` from `backupConfigBeforeOpenAiTierMigration` and notes init cleans the backup while start/service does not. KeepAlive then restarts forever → host proxy down.

### #1571 / #1570 / PR #1574
Same Volcengine Coding Plan 400. Live matrix: empty string OK, empty text array rejected. PR scopes structured placeholder to `/api/v3` only.

### #1544 / PR #1576
DeepSeek CodeModeOnly invents top-level `apply_patch`. PR fails closed on undeclared names and keeps nested Code Mode path. Closes #1544.

### #1592 / PR #1593 vs #1591
Registry ladder missing `xhigh` for grok-4.6. Two ready PRs; #1593 is the direct close of #1592, #1591 also adds Cursor Fast parameterization.

## D. What is intentionally not a prioritizable open bug

- Feature labels: #1572, #1217, #822, #540, most enhancement open issues
- Already-mitigated upstream trackers: #92, #417
- Architecture without live break: #1478
- UX mislabeled as bug: #1533
- Thin/possible-stale deepseek report #1594 until fresh capture proves a remaining hole after closed #1534/#906/#1499


## E. Batch C residual notes

- #1059 is a **Windows CI burn-down program**, not a one-PR product bug.
- #1049 is incomplete write-coordinator adoption for pre-substrate homes (child of #1048).
- #1024 residual is custom TokenRouter `TR/moonshotai/kimi-k3-free` modality metadata; Zen/Nemotron portions already resolved historically.
- #904 remains needs-info after clean wire re-verification.
- #1091 is intentionally restricted OAuth baseUrl (security design), not a bug.
- PR review attention order from deep-read: #1576 → #1593 (vs #1591) → #1583 → #1574 → #1597 → #1412 careful → #1585 → #1579 after hygiene → #1581 after rebase.

## F. External report added mid-cycle (Zhaorui, 2026-08-13)

| Ref | Class | Pri | Plain symptom | Disposition |
|---|---|---|---|---|
| **Zhaorui email** (no GH issue yet) | BUG | **P0** | 1) Built-in Moonshot preset always uses `api.moonshot.ai` so China-platform keys cannot stay on the preset. 2) Balance number is correct but unit is shown as dollars; China platform balance is **CNY/Yuan**. | Fix in this worktree: add Moonshot `baseUrlChoices` (intl/china/custom) + host-scoped balance labels (`¥ … CNY` on `.cn`, `$ … USD` on `.ai`). Custom-provider workaround remains valid. |
