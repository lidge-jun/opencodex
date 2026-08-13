# 010 — Landing round (2026-08-13 evening)

This document records what actually **landed** after the docs-only triage in `000`–`006`,
and re-states the remaining surface as of the post-merge tree.

Baseline at start: `origin/dev` `2cdbf66a2`
Baseline at close: `origin/dev` `9a4716f84`
Verification host: `lidge` (Linux, bun 1.3.14, 16 cores), full `bun run test` + `bun run typecheck`

## What landed

### Direct commits

| Commit | Change | Closes |
|---|---|---|
| `1849b947b` | Moonshot China endpoint choice (`.ai` / `.cn` / custom) + host-scoped `¥ CNY` / `$ USD` balance labels | Zhaorui email report (no GH issue) |

The balance amount is never converted. Only the unit label follows the host, because the
China platform bills in CNY and the international platform in USD; showing a Yuan balance
with a dollar sign was the actual defect.

### Merged pull requests

| PR | Merge commit | Author | What it fixes |
|---|---|---|---|
| #1576 | `7053e0077` | lidge-jun | Routed turns fail closed on an undeclared client tool name instead of aborting |
| #1575 | `be3597ff2` | lidge-jun | Two native-profile harness budgets raised to 10s (hosted macOS flake) |
| #1574 | `9da50d0a3` | lidge-jun | Volcengine structured empty-assistant placeholder scoped to `/api/v3` only |
| #1585 | `6ecfb5f56` | dbc-hbin | Muse Spark reasoning efforts advertised; `xhigh`/`ultra`→`max` aliasing restricted to documented models |
| #1593 | `2f3221dd5` | olddonkey | `grok-4.6` ladder gains `xhigh`, `grok-4.5` stays clamped |
| #1583 | `c523c5788` | jonathanli12 | Cursor unified `exec` pinned so `wait` cannot ship without its cell creator |
| #1597 | `2bc771451` | jonathanli12 | Responses continuation replay scoped to the client task |
| #1602 | `b63303228` | Eleven-is-cool | Deferred tools promoted in routed passthrough |
| #1603 | `00962e5bd` | luvs01 | Nous OAuth response bodies bounded to 64 KiB |
| #1604 | `13f212fe4` | luvs01 | Daybreak Blue Codex capability preservation |
| #1581 | `d1219c391` | Yuxin-Qiao | GUI select dropdown no longer overflows the viewport |
| #1605 | `98bdc4d2b` | LeoWang331 | Startup preserves a rollback snapshot instead of crash-looping |
| #1579 | `f1c84a427` (cherry-pick) | Jerome | Provider delete removes its OAuth credential set |

### Repairs made while landing

Three problems were invisible to each PR's own CI, because they only exist once two
changes share a tree:

| Commit | Problem | Resolution |
|---|---|---|
| `d1219c391` | #1581 conflicted with the vision-sidecar restructure that landed in between | Kept `dev`'s structure; the PR's viewport-half auto-detection covers those controls without an explicit prop |
| `b1e415972` | `memory-watchdog` pinned 11 `responseState` scalars; #1597 added a 12th | Counted 12. The assertion stays exact so a new field on this privacy surface must be reviewed |
| `6cc42f6ad` | #1604 expected `supports_search_tool=false` for a routed row | `fcbef381e` made deferred discovery the non-Cursor routed default and is not an ancestor of that branch; the case passes in isolation |

#1579 was cherry-picked rather than merged because its branch also carried a
`release: v2.14.0` commit — the reason intake marked it `hygiene-blocked`. `git cherry-pick -x`
takes the fix and leaves the release commit out of `dev`.

## Issues closed with evidence

| Issue | Reason | Proof on `dev` |
|---|---|---|
| #1599 | Fixed | `preserveOpenAiTierRollbackSnapshot` at `src/config.ts:594`, retried from `src/providers/openai-tier-startup.ts:21` |
| #1571 | Fixed | `isVolcengineArkPaygChatTarget` at `src/adapters/openai-chat.ts:676` |
| #1570 | Duplicate of #1571 | Same title, same reporter, same 400 |
| #1544 | Fixed | `declaredToolNames` at `src/server/responses/collaboration.ts:105` |
| #1592 | Fixed | `grok-4.6: [low, medium, high, xhigh]` at `src/providers/registry.ts:980` |
| #1563 | Fixed | 10s harness budgets in `tests/native-profile-manager.test.ts` |

GitHub does not auto-close these: `Closes #n` only fires on merge into the default branch
(`main`), and every PR here targets `dev`. Each was closed by hand with a comment naming
the merge commit and the verifying run.

## PRs deliberately not landed

| PR | Disposition | Concrete blocker |
|---|---|---|
| #1591 | Closed as superseded | #1593 closes the same issue in 11 files; #1591 also rewrites the Cursor effort map and request builder (24 files). The Cursor Fast piece was invited back as its own PR |
| #1568 | **Held — needs security review** | Rewrites Release-workflow tag creation from `git tag` + push to `gh api`, and adds `persist-credentials: false`. `AGENTS.md` requires explicit security review for release automation; correctness is not the question, authority is |
| #1607 | Deferred | Conflicts with the just-merged #1602/#1604 in `src/codex/catalog/provider-fetch.ts` and `sync.ts`. A 798-line feature PR should be rebased by its author rather than conflict-resolved blind during a landing round |
| #1608 | **Held — needs a product decision** | The bounding work is correct, but its Bun >= 1.4.0 gate disables the Codex WS upstream entirely on the pinned `1.3.14` runtime (`package.json`, every `bun-version` in `ci.yml`), so every turn falls back to HTTP SSE. Turning a transport off for all current users is a maintainer call; unblocks by stating that intent or landing with the Bun bump |
| #1412 | Deferred | +2685/-106. Adjacent to #1597 but a separate layer; needs a deep review, not a landing-round merge |
| #1584, #1569, #1557, #1552, #1547, #1526, #1521, #1510, #1498, #1422, #1367, #1165, #1008 | Out of scope | Feature/enhancement drafts, not bug fixes |

Every open PR carries a written disposition comment on GitHub; none was skipped silently.

## Verification ledger

| Round | Tree | Result |
|---|---|---|
| WP1 (Moonshot) | `1849b947b` | 11483 pass / 0 fail across 717 files, typecheck clean |
| WP2 (wave 1) | `2f3221dd5` | 11492 pass / 0 fail, typecheck clean |
| WP3 (wave 2, first run) | pre-repair | 11514 pass / **2 fail** — both stale assertions, diagnosed above |
| WP3 (wave 2, after repair) | `6cc42f6ad` | 11516 pass / 0 fail, typecheck clean |
| WP5 (#1605 + docs) | `9a4716f84` | 11527 pass / 0 fail across 717 files, typecheck clean |

Each run is a fresh execution on `lidge`, not a remembered result.

## Remaining open bug-labeled issues: 20

Down from 23 at the morning cutoff. #1599, #1571, #1570, #1544, #1592, and #1563 were all
closed by hand with evidence, since a PR merged into `dev` never triggers GitHub's
auto-close; the count also moves as new reports arrive.
The child-level explanation of what is left is in `011_remaining_simple_korean.md`.
