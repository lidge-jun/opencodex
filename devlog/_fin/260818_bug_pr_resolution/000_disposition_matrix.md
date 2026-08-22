# 000 — Bug-PR resolution campaign: disposition matrix

Four parallel grok-4.6 disposition audits against `origin/dev` `0f5ccf9aa`,
2026-08-18. 24 bug-labeled PRs. Verdicts are per current heads, not stale
campaign notes. Execution: WP1 (ready), WP2 (drafts + redesigns), WP3
(issue sweep + docs drift), WP4 (Windows rollback / tsig follow-ups),
WP5 (closeout).

## Matrix

| PR | Verdict | Linked issue | Note |
|---|---|---|---|
| #2007 | MERGE (rebase 1 hunk) | #45 (closed) | raw reasoning through expandable summary; core.ts clash with backfill |
| #1991 | MERGE | — | context cap as window when upstream omits it |
| #1935 | MERGE-SQUASH | — | tooltip mojibake fix; 2 merge commits in history |
| #1931 | MERGE | — | sync catalog-only refresh when injection OFF |
| #1920 | REDESIGN-SMALL | #1866 | apply formatted.text at native toolResultPart + decode test |
| #1912 | MERGE | — | stale CHANGES_REQUESTED; head keeps order + fail-closed pins |
| #1883 | MERGE-SQUASH | — | stdin Copilot runner; 17 micro-commits; security review first |
| #1876 | REDESIGN-SMALL | #1852 | rebase onto fail-closed snapshot API; keep async collector, 250ms TTL |
| #1859 | MERGE | — | OpenRouter provider preserved in native chat passthrough |
| #1847 | MERGE | — | NUL-delimited changelog parsing |
| #1845 | MERGE | — | MiniMax bridge loopback pin |
| #1833 | CLOSE-STALE | — | chore mislabeled bug; 486 behind, lockfile conflict |
| #1990 | MERGE (rebase test conflict) | — | session-id pinning still unique on dev |
| #1940 | REDESIGN-LARGE-CLOSE | #1527 | 1064-line store; close with split directive after #1990 |
| #1932 | REDESIGN-SMALL | — | WHAM 401 transient gate; tighten undecodable-exp handling |
| #1896 | REDESIGN-SMALL | #1844 (merged) | keep functions-namespace flatten; drop hardcoded names |
| #1889 | REDESIGN-SMALL | #1836 (closed) | only x-goog-api-client drop remains; rebase leftover |
| #1888 | REDESIGN-LARGE-CLOSE | — | 1233 lines, core.ts conflict, CHANGES_REQUESTED; close+restack |
| #1887 | REDESIGN-LARGE-CLOSE | — | 335 behind, 5-file conflict; re-cut on current dev |
| #1851 | MERGE-SQUASH | — | Vertex transient retry; P1 resolved at head |
| #1842 | REDESIGN-SMALL | — | OAuth redaction; preserve typed identity errors |
| #1800 | MERGE (rebase slug-codec) | — | commandcode reasoning table + GLM slugs still unfixed |
| #1748 | REDESIGN-SMALL | — | outbound-only fake-IP proxy routing (avoid SSRF widening) |
| #1725 | MERGE-SQUASH | — | warmup response bounds; threads resolved |

Tally: MERGE 9 · MERGE-SQUASH 4 · REDESIGN-SMALL 7 · REDESIGN-LARGE-CLOSE 3 · CLOSE-STALE 1.

## Issue-closure rules for this campaign

- A merged/closed PR that resolves an open issue closes that issue in the
  same work-phase (PRs target dev; no auto-close).
- WP3 sweeps issues already resolved by past dev merges.
- #1587 (design cycle) and #1885 (held) are OUT of this campaign.

## Decade map

- 010 WP1: execute MERGE/MERGE-SQUASH for ready PRs (2007 1991 1935 1931
  1912 1883 1859 1847 1845 1851 1725 as heads allow) + CLOSE-STALE 1833.
- 020 WP2: REDESIGN-SMALL batch (1920 1876 1932 1896 1889 1842 1748) as
  fresh scoped branches; REDESIGN-LARGE-CLOSE (1940 1888 1887) with
  directives; #1990 merge after rebase.
- 030 WP3: resolved-issue sweep + structure/04 drift line.
- 040 WP4: Windows rollback (#1942/#1849) and tsig credential half
  (#1926): bounded-implement or decade-doc into the windows program unit.
- 050 WP5: lidge gates + outcome ledger + _fin.

Per-PR validation: scratch-worktree merge onto current dev, the worker's
named suites + tsc, evidence comment, admin merge (--squash where marked).

