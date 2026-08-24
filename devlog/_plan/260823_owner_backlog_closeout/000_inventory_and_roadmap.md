# 000 — Owner backlog closeout: inventory and disposition roadmap

Unit opened 2026-08-23. Session `01a02ef0-72d8-76b3-aa58-332bc348386d`.
Goalplan slug `close-out-the-owner-backlog-on-lidge-jun-opencod`.

## Why this unit exists

Twenty items were open against `dev` at `bf8bcfd3c`: six pull requests and five
issues from maintainer `Ingwannu`, and nine issues from `lidge-jun`. None of them
had a recorded terminal disposition. This unit gives every one of them a verdict
backed by evidence, one PABCD work-phase per item.

## Method

Eleven read-only `gpt-5.6-sol` reviewers ran in parallel at high effort: one per
Ingwannu PR, one per issue that needed a reproduction check. Each returned a
file:line-cited verdict with the focused test command it actually ran. Their
verdicts are recorded below verbatim in outcome, not in prose summary.

The loop merges bottom-up one item at a time. Pushes use `--no-verify` by owner
instruction; the expensive full suite is not run locally per item. CI is checked
on the final head, and each merge is confirmed on `origin/dev` before the next
work-phase starts.

## Reviewer verdicts — Ingwannu pull requests

| PR | Title | Verdict | Disposition | Evidence |
|----|-------|---------|-------------|----------|
| #2439 | fixture-backed OpenAI contract manifest | PASS_WITH_NITS | squash-merge | `tests/compatibility-manifest.test.ts` 6/6, `core-lab-boundary` 13/13, docs build 393 pages, CI 23 pass at `0225f2b9` |
| #2437 | centralize history manifest contract | PASS | merge | `codex-history-provider` + `codex-native-residue` + boundary 142/0, CI 23 pass |
| #2435 | isolate Responses fetch helper imports | PASS | squash-merge | 6 focused files 71 pass / 1 skip, CI 23 pass at `be6ea98a` |
| #2433 | fail over zero-output stream failures | **FAIL** | needs changes | double terminal accounting at `src/server/responses/core.ts:1974` vs inspectors at 3785/3868 — one 502 yields `consecutiveFailures: 2` |
| #2387 | extract proxy process-state ownership | PASS_WITH_NITS | squash-merge | 472/0 across 8 suites, merge simulation 473/0, typecheck pass, CI 29 pass |
| #2380 | extract provider validation boundary | PASS | merge | 187/0 + `config.test.ts` 153/0, typecheck pass, CI 23 pass |

The single blocker is #2433. Its preflight records `response.failed` a second
time on native passthrough, where the eager and tee inspectors already recorded
it. That is not a style objection: it halves the effective failover threshold on
a healthy credential, so the PR waits for an exactly-once recorder plus a
regression asserting one health transition per streamed attempt.

## Reviewer verdicts — issues

| Issue | Status on `bf8bcfd3c` | Disposition | Evidence |
|-------|----------------------|-------------|----------|
| #2443 wait float rejection | REPRODUCES | fix (small) | `src/lib/tool-argument-integers.ts:75-78` allowlists only `timeout_ms`; `a9cb7661b` fixed #2316 alone |
| #2436 history manifest leaf | covered by #2437 | close on merge | — |
| #2434 fetch helper boundary | covered by #2435 | close on merge | — |
| #2392 auth-context error mapping | REPRODUCES (structural) | fix (small) | duplicate matrices at `core.ts:1537` and `compact.ts:397`; user-visible half already fixed by `d52032ebe` |
| #2379 provider validation | covered by #2380 | close on merge | — |
| #2378 process-state ownership | covered by #2387 | close on merge | — |
| #2292 Windows stale picker | fixed by #2382 | close | opt-in desktop restart landed |
| #2152 Windows CI shards | partially fixed | fix (test-only) | symlinks fixed by `8f04c9a52`, Bun panic by `0776683`; two WP13 failures remain from CPU starvation at `tests/helpers/codex-write-lock-child.ts:49` |
| #1702 combo quota badges | REPRODUCES | fix (medium) | `gui/src/pages/Combos.tsx:110-117` never calls `/api/provider-quotas`; abandoned `c8c4358a1` is not an ancestor of dev |
| #1587 routed tool catalog bloat | ALREADY_FIXED | close stale | `fcbef381e` cut 258,929 to 96,699 chars; `catalog-cursor-search` 17/17 |
| #1478 config rebase provenance | roadmap | retain | architecture item, no code path pending |
| #1049 pre-substrate Codex homes | roadmap | retain | deferred in `260822_backlog_disposition_program` WP6 |
| #1048 WP13 composed acceptance | partially implemented | retain, link #2152 | PR #1106 landed the suite; remaining gap is the Windows leg |
| #820 32-session memory bound | roadmap | retain | architecture item spanning its own program |

## Work-phase map

wp0 is this document. wp1–wp6 dispose of the six Ingwannu PRs and close their
linked issues. wp7–wp16 handle the remaining issues in the order recorded in the
goalplan. One decade doc per implementation work-phase, written when that phase
opens rather than pre-written, because every reviewer verdict above already
carries the diff-level plan its phase needs.

