# 003 — Priority ranking (what to do first)

This is a **queue**, not a schedule. Severity × blast radius × evidence × fix readiness.

## Top action queue for maintainers

### Tier 0 — ship now (external China Moonshot breakage)

| Order | Action | Why first |
|---:|---|---|
| 0 | **Zhaorui report: Moonshot China endpoint + CNY balance unit** | Built-in Moonshot forces `.ai`; China users must leave the preset. Balance amount is right but unit shows `$` instead of **¥/CNY** on `.cn`. Highest user-facing money-display + onboarding break. |

### Tier 1 — review/merge almost ready fixes first

These convert open bugs into closed bugs with the least new design risk.

| Order | Action | Why first |
|---:|---|---|
| 1 | Review/merge **PR #1576** → #1544 | Confirmed product break; green; fail-closed contract fix |
| 2 | Review/merge **PR #1593** → #1592 (decide vs #1591) | Capability clamp is live; two overlapping PRs need one winner |
| 3 | Ready + merge **PR #1574** → #1571/#1570 | Confirmed provider regression; draft but scoped |
| 4 | Review **PR #1585** | Small capability advertisement fix, review-ready |
| 5 | Review **PR #1575** → #1563 | Tiny CI flake fix; release-noise reduction |
| 6 | Un-draft/review **PR #1583** | Cursor exec/wait pin prevents tool loops |

### Tier 2 — write new fixes for high-impact open bugs with no ready PR

| Order | Issue | Why next |
|---:|---|---|
| 7 | **#1599** macOS service crash-loop | Host proxy never comes up |
| 8 | **#1589** Windows Hidden PowerShell identity | Blocks config/sync identity path |
| 9 | **#1573** Windows non-ASCII path codec | Blocks Korean/locale Windows ownership + sync |
| 10 | **#1527** Cursor large-context collapse | Major adapter path reliability |
| 11 | **#1302** CI hang / orphan bun | Maintainer throughput tax |
| 12 | **#1582** openai-chat baseUrl double path | Common custom-provider 404 |
| 13 | **#1562** GUI V2 silent fail when `codex` missing | Ready product bug: surface ENOENT instead of silent no-op |

### Tier 3 — needs reporter artifact or design before coding

| Order | Issue | Gate |
|---:|---|---|
| 14 | #1419 SIGTRAP | `.ips` main-thread frames + CA/proxy context |
| 15 | #1483 MiMo tool_calls residual | redacted nested frame shape |
| 16 | #1580 usage history shrink | retention/query forensics |
| 17 | #1587 catalog token bloat | design for prune/defer/cache |
| 18 | #1524 fallback preflight | shared capability policy design |
| 19 | #1049 pre-substrate homes | migration/coordinator design |
| 20 | #1024 vision residual | TokenRouter-only remaining case |
| 21 | #1296 ACL→401 residual | prove current producer path or document historical |

### Tier 4 — low urgency / tracking

| Item | Disposition |
|---|---|
| #1581 GUI dropdown | polish; draft PR exists |
| #1597 continuation task scope | important, still draft |
| #1579 credential delete | hygiene-blocked |
| #1412 oversized input guard | large careful review |
| #1563 | handled by #1575 |
| #1533 | UX copy, not runtime bug |
| #1478 | architecture roadmap |
| #1594 | thin report; verify before reopening deepseek work |
| #1570 | duplicate of #1571 |
| #1388, #904 | needs-info / upstream-ish |
| #417, #92 | upstream tracking |
| #1059 | Windows suite program, not one patch |

## Suggested campaign slices (if a later implementation loop is authorized)

Dependency-ordered, not effort-bucketed:

1. **Service/Windows survival stack** — #1599, #1589, #1573  
   Host must start and prove ownership before other local features matter.
2. **Provider contract stack** — land #1576/#1574/#1593 then #1582/#1585/#1583  
   Keep routed providers from 400/abort/wrong capability.
3. **Cursor reliability stack** — #1527 then residual #1388 tracking  
   Large-context continuation truth.
4. **CI survivability stack** — #1575/#1600 disposition + #1302 investigation  
   Protect the merge train.
5. **Observability/data trust** — #1580, later #1217 feature if desired  
   Usage numbers people believe.

## Explicit non-priorities right now

- New providers / OAuth features / roadmap enhancements
- Spanish localization and other pure enhancements
- Security writeups in public devlog (none opened as public pre-disclosure here)
- Closing upstream trackers without external proof

## Scoreboard snapshot

| Bucket | Count (approx) |
|---|---:|
| Open issues total | 70 |
| True/open product bug surface after cull | ~24 actionable-ish |
| Ready/near-ready fix PRs | 6–7 |
| Blocked on info/upstream/architecture | ~10 |
| Feature false positives removed | 5 from candidate sweep |

"Prioritizable now" = Tier 1 + Tier 2 (~12 items). Everything else waits on evidence, design, or is tracking.


## Overlap clusters (from parallel PR deep-read)

| Cluster | Items | Rule |
|---|---|---|
| Grok 4.6 xhigh | PR #1593 vs #1591 | Land one strategy. Prefer #1593 for pure xAI close of #1592; fold Cursor Fast from #1591 as follow-up if still needed. |
| Responses replay safety | PR #1412 vs #1597 | Adjacent layers, not duplicates. #1412 = oversized admission/dedup; #1597 = task-scoped continuation keying. |
| CI flake | #1575 / #1600 | Chore only; #1575 closes #1563. #1600 was red at cutoff. |
| Volcengine twin issues | #1571 / #1570 | Canonical #1571; #1570 duplicate. |

## Ready-signal caveats

- PR #1583 is labeled `review-ready` but still **draft**.
- PR #1581 reported **CONFLICTING** / needs rebase.
- PR #1579 is `intake: hygiene-blocked` (hygiene + enforce-target FAIL); contains contaminated release commit per deep-read.
- PR #1574 CI looks merge-grade but remains draft.
- PR #1412 is high-value and high-risk (+2685 lines); deep review, not fast-merge.
