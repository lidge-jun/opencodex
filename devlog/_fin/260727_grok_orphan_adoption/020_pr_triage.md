# 020 — WP2: PR triage and merge order

Snapshot taken at `dev`/`preview`/`main` = `6062b202`. Triage performed by an
independent sol subagent that read each non-draft PR's diff and CI state; the
security-surface judgements below carry its `path:line` evidence.

## Verdict table

| PR | Risk | CI at exact head | Verdict |
|---|---|---|---|
| #492 | none | passing, full matrix | **MERGE (1st)** |
| #482 | release automation — review satisfied | passing, full matrix | **MERGE (2nd)** |
| #408 | privileged Windows execution — review satisfied | passing + Windows service checks | **MERGE (3rd)** |
| #494 | none | **never ran** (`action_required`) | HOLD — needs CI approval |
| #493 | OAuth token probes | failing/cancelled | HOLD — conflicting + security review |
| #491 | stored credential handling | never ran | HOLD — conflicting + security review |
| #424 | token + SSRF surface | never ran | HOLD — security review |
| #498 #495 #461 #447 #429 #426 #355 | — | — | draft, not candidates |
| #455 | — | — | targets `dev2-go`, self-labelled WRONG BRANCH |

## Merge order and why

1. **#492** — image-tool conflict detection across nested `additional_tools`. Smallest
   isolated runtime change, focused regression test, green on the full matrix.
2. **#482** — carries preview changelogs into stable release notes. Touches
   `.github/workflows/release.yml` (tag creation, `gh release create`), which
   `AGENTS.md` marks as requiring explicit security review; the exact-head owner
   approval covers that scope and CI is green. No write overlap with #492.
3. **#408** — Windows Task Scheduler retry via scoped UAC elevation. Last because it has
   the broadest privilege impact, even though its review and Windows-specific checks are
   green. Elevation resolves system binaries through `GetSystemDirectoryW` rather than
   environment-controlled paths (`src/lib/windows-elevation.ts:63-76`).

`dev` advances after each merge, which invalidates the previous integration snapshot —
so mergeability and exact-head checks are re-read between merges rather than trusted
from this table.

## Held back, with the specific reason

- **#494** (reasoning-effort logging): the code looks Bun-compatible and well-tested, but
  its substantive workflows are `action_required` and have never run. Merging on
  unproven CI is exactly what the branch policy exists to prevent. Should land before
  #424 when unblocked — both touch `src/server/responses/core.ts`.
- **#493** (per-account Anthropic quota): conflicting, CI failed/cancelled, and it sends
  per-account OAuth tokens as `Authorization: Bearer` to Anthropic
  (`src/providers/quota.ts:194-200`, `:292-294`) with a `?quota=1` route that probes
  EVERY stored account (`oauth-account-routes.ts:179-185`). Needs a rebase and a
  deliberate credential review, not an autonomous merge.
- **#491** (OAuth preserving stored keys): conflicting, no core CI, and it copies
  `existing.apiKey` / `apiKeyPool` / `authMode: "key"` into the OAuth provider preset
  (`src/oauth/index.ts:624-631`). Credential-handling change — human approval required.
- **#424** (xAI image bridge): broad token handling plus an SSRF-sensitive boundary that
  fetches a provider-returned URL (`src/images/artifacts.ts:92-100`), with no core CI.

## Decision recorded

Merging the three green, reviewed PRs is within this goal's scope. The four held PRs
each need either a human security decision or a CI run that only a maintainer can
approve — those are reported, not merged. That is a NEEDS_HUMAN boundary on those
specific PRs, not on the goal.
