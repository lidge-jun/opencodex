# 090 — Merge log: the bug-PR backlog landing on dev

Unit: 260820_bug_pr_backlog_consolidation
Work-phases: wp21-wp25.
dev before: `31ee7a683`. dev after: `a584890f8`.

## The override that was not needed

All 19 PRs sat at CHANGES_REQUESTED from @Ingwannu with green CI, and the plan was to merge
with admin authority. Three independent read-only lanes read every blocking review first, and
the answer was the same in all three: **the objection was factually current, not stale.**

The recurring complaint was "this head is N commits behind dev". Measured, it was true
everywhere — 16 to 25 commits, and `dev` had itself advanced to `31ee7a683` while the reviews
were being written. A green check on a stale head validates an integration state that no longer
exists, which is a real merge-readiness defect rather than a formality to wave through.

So the resolution was to rebase all 19 branches onto current `dev`, not to override. Admin
authority can bypass a gate; it cannot make an untested integration state tested.

Two reviews named genuine code defects, and both were fixed rather than overridden:

- **#2166** — `addRequestLog` is exported and bypassed the sanitizer: the reviewer reproduced a
  raw 111-character value in the `/api/logs` ring against a sanitized 37-character value on
  disk. Fixed at the shared ingress so both surfaces read from one normalized entry, with the
  direct-ingress regression the reviewer asked for.
- **#2162** — a prompt mutation writing into the outbound user turn needed its content-shape
  boundaries pinned. Added: an already-framed turn stays single, image-only content keeps its
  image block behind the preamble, assistant-only block content keeps its tail before the
  synthesized `(continue)` turn.

One more objection dissolved on rebase: #2148 was carrying eight `devlog/_plan/` planning files
inherited from its branch point. The rebase removed them.

## What landed

19 PRs, merged bottom-up. Every merge commit verified present in `git log origin/dev`.

| PR | dev merge commit | Absorbed from |
|---|---|---|
| #2134 | `930840ca4` | maintainer fix |
| #2160 | `114e9e543` | #2067 @waw4303 |
| #2162 | `087c3c368` | #2082 @yzxcj797 |
| #2164 | `31750b094` | #2027 @yzxcj797 |
| #2165 | `41689b374` | #2155 @waw4303 |
| #2166 | `5fbe65570` | #2163 @Ingwannu |
| #2137 | `be12328bc` | issue #2132 |
| #2146 | `aa07bc308` | #2101 @Ingwannu |
| #2138 | `81492fd10` | #2102 @lilinxiong |
| #2140 | `3ad9c7bf4` | #2100 + #2077 @ntdatt812 |
| #2141 | `1cc35c560` | #2056 @Ingwannu |
| #2142 | `52a463dd6` | #2131 @bet4it |
| #2144 | `8c8a66816` | #2105 @lilinxiong |
| #2145 | `83d5ffa3c` | #2040 @Ingwannu |
| #2147 | `7fc50846b` | #2104 @olddonkey |
| #2148 | `86ed9ed83` | #2109 + #2110 @drakonkat |
| #2149 | `17e8e916b` | #2053 @Ingwannu |
| #2150 | `9a7801547` | #2127 @agentHits |
| #2151 | `a584890f8` | #2075 @olddonkey |

Verification that the rebased content is what actually landed, split by what is still
re-runnable:

- **Re-runnable today:** every merge SHA in the table above satisfies
  `git merge-base --is-ancestor <sha> origin/dev` (verified 2026-08-21, 19/19 true) — the
  recorded merge commits are exactly the commits on `dev`, so the landed content is the
  table's content by construction.
- **Historical assertion, no longer re-runnable:** six of the merges recorded a pre-rebase
  branch SHA in their description. At merge time each rebased branch was compared with
  `git diff --name-only origin/dev <branch> -- <that PR's own src/ and tests/ paths>` and
  returned 0 differing files. The source branches were deleted in the wp0 cleanup
  (260820 unit, executed record), so those comparisons cannot be reproduced from this log;
  they stand as recorded assertions, not evidence, and the re-runnable ancestor check above
  is the durable audit trail.

## Security surfaces, named rather than merged silently

`MAINTAINERS.md` reserves auth, credential handling, OAuth, workflows, and release automation
for explicit human review. Seven of the merged PRs touch that surface, and the user's merge
authorization is the human decision of record for each:

- **#2137 / #2146** — bearer admission and stored-credential substitution; entitlement-gated
  model discovery sends the selected account's access token.
- **#2144** — decides whether the shell hook exposing `ANTHROPIC_AUTH_TOKEN` is installed.
- **#2145** — lowers third-party `function_call` output and restores it as a client-executed
  private `tool_search_call`.
- **#2147** — OAuth 401 refresh and access-token replay.
- **#2148** — operator-selected destinations for Anthropic/Antigravity OAuth bearers. The
  transport gate still rejects public cleartext HTTP; only explicitly opted-in local/private
  relays may use it.
- **#2149** — OAuth credential commit ownership under the store lock.

## Issue closure

Every issue named by a merged PR is closed: #2133, #2132, #2092, #2047, #1950, #2097, #1886,
#2125, #2074, #1924, plus the superseded contributor PRs. Verified by `gh api` state, not by
assuming GitHub auto-closed them — these PRs targeted `dev`, not `main`, so auto-close does not
fire.

## Release readiness — not a release

At `a584890f8`:

- `bun run test` — 13716 pass / 10 skip / 0 fail across 866 files.
- `bun x tsc --noEmit` — exit 0.
- `bun run privacy:scan` — passed.
- `package.json` version line: **2.27.0** (unchanged by this campaign).

Changed surfaces: provider registry and transport headers, quota dispatch, routing capability
resolution, the Anthropic/OpenAI-chat/Google adapters, Responses core and compact, OAuth store
and credential commit, request logging and usage persistence, subagent roster management.

Not done, and deliberately: no `scripts/release.ts`, no npm publish, no tag, no change to
`main` or `preview`. Release execution needs its own authorization.

## Still open

**#2054** (@keepitmello) stays open by explicit instruction, carrying the wire-probe request.
**#2167** (@ntdatt812) arrived after this campaign and is untriaged.
