# 001 — Live inventory (2026-08-13)

Repo: `lidge-jun/opencodex`  
Fetch evidence: `.tmp/bug-triage-20260813/issues-open.json`, `prs-open.json`  
Commands:

```bash
gh issue list --state open --limit 200 --json number,title,labels,createdAt,updatedAt,author,body,url,comments
gh pr list --state open --limit 100 --json number,title,labels,createdAt,updatedAt,author,isDraft,baseRefName,headRefName,url,body,additions,deletions,changedFiles,mergeable,statusCheckRollup
```

## Totals

| Metric | Value |
|---|---:|
| Open issues | 70 |
| Open PRs | 26 |
| Issues with label `bug` | 23 |
| Open PRs titled `fix(...)` or labeled `bug` | 10 |

## Open issues with label `bug` (23)

| # | Title (short) | Other labels |
|---:|---|---|
| 1599 | macOS launchd crash-loop OpenAiTierBackupCollisionError | cli, platform, service |
| 1594 | DeepSeek openai-response error in Codex app | proxy |
| 1589 | Windows PowerShell `-WindowStyle Hidden` EACLIDENTITY | platform |
| 1587 | Routed first-turn tool catalog 3–5x native tokens | catalog, proxy, tools |
| 1582 | openai-chat doubles `/chat/completions` | provider |
| 1580 | Usage dashboard loses previous-day history | gui, cli |
| 1571 | Volcengine kimi tool-call continuation 400 | provider, tools |
| 1563 | CI native-profile macOS flake ~6000ms | platform |
| 1562 | GUI V2 silent fail when `codex` missing | gui |
| 1533 | UX: native-to-routed V2 compatibility explanation | gui |
| 1527 | Cursor large-context collapse/rate-limit | tools |
| 1524 | Preflight fallback for context/modality | account-pool, proxy |
| 1478 | Config rebase provenance deletion vs unseen | enhancement, roadmap |
| 1419 | macOS Bun SIGTRAP after TLS/reset | needs-info, platform, service |
| 1388 | Cursor apply_patch exact-match drift | upstream-tracking, needs-info, stale, provider |
| 1302 | CI Linux test hang / orphan bun | chore, service |
| 1296 | Windows ACL failure returned as 401 | account-pool, proxy, platform |
| 1059 | Windows suite dispatch-only until green | platform |
| 1049 | Adopt pre-substrate Codex homes into coordinator | — |
| 1024 | Custom-provider vision ambiguous without metadata | — |
| 904 | Korean file write U+FFFD — need failing capture | needs-info |
| 417 | Upstream Korean realtime voice U+FFFD | upstream-tracking, cli |
| 92 | V2 encrypted NEW_TASK body loss | upstream-tracking, tools |

## Additional non-`bug`-label candidates retained after read

| # | Why retained | Result class |
|---:|---|---|
| 1592 | provider-compat clamp of grok xhigh | BUG |
| 1573 | Windows Korean path UTF-8/FFFD blocks service ownership | BUG |
| 1570 | identical title to #1571 | DUPLICATE |
| 1544 | provider-compat DeepSeek undeclared apply_patch | BUG |
| 1483 | MiMo invalid tool calls / ladder | NEEDS-INFO (partially fixed) |

## Explicit false positives from keyword sweep (NOT bug work)

| # | Title | Why excluded from bug queue |
|---:|---|---|
| 1572 | re-evaluate routing profile on terminal failure | `enhancement` feature request |
| 1217 | durable stream-stage timeline | `enhancement` observability feature |
| 1091 | custom upstream URLs for ChatGPT OAuth | compatibility/feature request |
| 822 | crash-safe reset-credit auto-redemption | `enhancement` lifecycle feature |
| 540 | WordPress Studio Code provider | roadmap feature |

## Open bug / fix PRs (10)

| # | Draft | Labels | Title | Linked / notes |
|---:|---|---|---|---|
| 1597 | yes | bug | scope continuation replay to client task | continuation cache isolation |
| 1593 | no | bug, review-ready | expose Grok 4.6 xhigh | closes #1592 |
| 1591 | no | bug, review-ready | Grok 4.6 xhigh + Cursor Fast | overlaps #1592/#1593 |
| 1585 | no | bug, review-ready | command-code muse spark reasoning efforts | capability advertisement |
| 1583 | yes | bug, review-ready | pin Cursor unified exec so wait cannot ship alone | Cursor tool pin |
| 1581 | yes | bug | GUI select dropdown overflow | UI polish bug |
| 1579 | yes | bug, intake: hygiene-blocked | remove OAuth credentials on provider delete | hygiene FAIL |
| 1576 | no | bug | reject undeclared routed tool calls | closes #1544; CI green |
| 1574 | yes | bug | volcengine assistant placeholder by endpoint | closes #1571 |
| 1412 | yes | bug | refuse oversized input / stop compounding history | large draft |

## Adjacent non-bug but CI-related open PRs

| # | Title | Note |
|---:|---|---|
| 1600 | scale timing watchdogs for loaded CI | chore; macOS/ci FAIL at cutoff |
| 1575 | bound hosted macOS busy-probe | chore; closes #1563; green |

## Parallel deep-read lanes

| Lane | Agent | Scope |
|---|---|---|
| A | Dewey `019ffa9f-86f7-...` | issues 1599–1563 batch |
| B | Helmholtz `019ffa9f-87a5-...` | issues 1562–1296 batch |
| C | Cicero `019ffa9f-8893-...` | remaining issues + all fix PRs (partial at synthesis; main re-verified PR JSON) |

Main session re-checked key states with `gh issue view` / open PR rollup before ranking.

## External report not yet filed as GH issue

- **Zhaorui (email, 2026-08-13):** Moonshot preset stuck on `.ai`; China `.cn` needs custom provider. Balance amount correct, unit wrong (`$` vs Yuan/CNY).
