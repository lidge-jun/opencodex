# 050 — wp5: GitHub-only CLOSE batch

Work-phase wp5 of unit `devlog/_plan/260909_bulk_closeout_249`. Sources: 002 (§#4016), 004
(§#3994 #3989 #3464 #3320 #3245), 005 (§#2805 #3266 #4001 #3255), 008 (§#2527 #2462), consolidated
in 006.

**Nothing in this document is executed until the maintainer authorizes wp5.** Every comment body,
`gh issue close`, and `gh pr close` below is a prepared artifact. No comment has been posted, no
item closed, and no `.tmp/` file written by the author of this doc.

## Objective

Remove twelve items from the live backlog with no tree change: eight issues and four pull requests
that are already fixed on `dev`, duplicated, superseded by a landed implementation, or stale beyond
the point where their evidence describes current code. Then record the seven merge-linked issues
that must be closed by hand after their owning PR lands, because `Closes #N` fires only on merge
into the default branch and every PR here targets `dev`.

wp5 touches no files, so it is file-disjoint from wp1/wp2/wp3/wp4/wp6 by construction and can run
at any point in the cycle. Its only ordering constraint is internal: the seven auto-close rows
depend on their owning PR landing first.

## Preconditions

- Base at research and at write time: `origin/dev` = `7dc7dc99e65268bc8764e19840952256b030bce9`
  (re-fetched immediately before verdict; unchanged).
- All twelve targets re-confirmed `OPEN` at write time via `gh issue list` / `gh pr list`
  (`--repo lidge-jun/opencodex`).
- `gh` 2.91.0. `gh issue close` supports `--comment` and `--reason {completed|not planned|duplicate}`;
  `gh pr close` supports `--comment` and `--delete-branch`. **Never pass `--delete-branch`** here — all
  four PRs are fork branches owned by their authors, and three of the four comments invite a rebase.
- **CI approval gate does not apply to wp5.** It has no head, no workflow run, and no merge. The
  gate note carried from 006 — contributor PRs have no `ci.yml` run at head, so a maintainer must
  approve workflows or carry onto a maintainer branch — governs wp1/wp2/wp3/wp6 only. It is
  restated here because the seven auto-close rows at the end are downstream of exactly those merges.
- Scratch directory: `.tmp/` in the working tree, gitignored at `.gitignore:30`. Comment bodies are
  written there and deleted at the end of the phase. Nothing in wp5 is committed.
- Authorization state: **NOT GRANTED at time of writing.** Run nothing below until the maintainer
  says wp5 executes.

## Stack order and conflict map

wp5 has no file conflicts. The ordering below is about blast radius and reversibility, not merges.

| Order | Group | Items | Why here |
|-------|-------|-------|----------|
| 1 | Fixed-on-dev issues | #3989 #3464 | Purely factual: the fix is quoted from `dev` at an exact line. Lowest risk, closes first so an early stop still banks two. |
| 2 | Duplicate / conceded issues | #3994 #3266 #3255 | The reporter proposed or agreed with the disposition in-thread. Reversible and unlikely to be contested. |
| 3 | Maintainer-owned issue | #4001 | `lidge-jun`'s own scratch item; no external party is closed out. |
| 4 | Stale needs-info issues | #3320 #3245 | These close a report the reporter still believes in. Post last among issues so the comment gets full attention, and both explicitly invite reopen. |
| 5 | Duplicate PR | #4016 | Same author still active on #3954; the comment redirects rather than rejects. |
| 6 | Unrebasable PRs | #2805 #2462 | Large abandoned work; comments acknowledge effort and name a live destination. |
| 7 | Overriding-recent-activity PR | #2527 | **The one close that overrides a contributor who pushed on 2026-09-05.** Deliberately last: if the maintainer changes their mind on any single item, this is the one to drop. |

Two cross-item couplings to respect:

- **#4016 before or independent of #3954, never both.** #3954 stays open (006: REIMPLEMENT,
  deferred out of this cycle; verified `OPEN`, non-draft, head `8b90fbfbb`, `CHANGES_REQUESTED`).
  Closing both would drop the underlying `MissingSessionID` report entirely.
- **#2462 requires #95 to stay open** (verified `OPEN`), and **#3255 requires #3377 to stay open**
  (verified `OPEN`). Both comments redirect there. If either is closed first, revise the comment
  before posting.

## Per-item procedure

Each item gives the comment body as a heredoc into `.tmp/`, the exact close command, and the
verification command. Run from the repository root, `/Users/jun/Developer/new/700_projects/opencodex`.
All heredocs use a quoted delimiter (`'OCXEOF'`) so backticks in the body are never executed by the
shell.

Set once per session:

```bash
mkdir -p .tmp
export OCX_CLOSE_REPO=lidge-jun/opencodex
```

### Issue #3989 — Hermes whole-file conflicts (rrmlima) — fixed on dev

Evidence re-verified in `/tmp/ocx-249.xGQnxl/wt`: `src/integrations/registry.ts:193` carries
`sourcePreservingYaml: { path: ["providers", "opencodex"] }` inside the `hermes` entry (lines
189–194), and `git log --oneline -1 a0e794d1d` →
`feat(integrations): support source-preserving YAML for Hermes Agent (#3989)`.

```bash
cat > .tmp/close-3989.md <<'OCXEOF'
Fixed on `dev`.

`INTEGRATION_CLIENTS.hermes` now declares `sourcePreservingYaml: { path: ["providers", "opencodex"] }`
at `src/integrations/registry.ts:193`, so `classifyIntegration` scopes ownership to that subtree.
Sibling providers, comments, and auxiliary models in a shared `~/.hermes/config.yaml` no longer
trigger a `foreign-edit` / `unowned-key` whole-file conflict or the destructive Replace prompt.

This landed via #4030 as `a0e794d1d` ("feat(integrations): support source-preserving YAML for
Hermes Agent (#3989)"), carrying your commit from #3990 with `git cherry-pick -x`. The issue was
simply never closed alongside it.

Thank you for the report — naming the missing registry field is what made this a one-line fix.

Closing as fixed. If a multi-provider Hermes config still reports `conflict` on a build from current
`dev`, please reopen with the `state` / `reason` JSON and your `ocx` version.
OCXEOF

gh issue close 3989 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-3989.md)"
```

Verify: `gh issue view 3989 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #3464 — mise upgrade leaves launchd on an old version (garysassano) — fixed on dev

Re-verified: `src/service.ts:488-499` is the `buildPlist` docstring naming #3464 as the macOS
counterpart of #2898, `buildPlist` declared at `:497` taking `deps.launcher`, and `:2296-2297`
resolving `stableLauncherEntry()` once and writing it into install state.

```bash
cat > .tmp/close-3464.md <<'OCXEOF'
Fixed on `dev`.

macOS now has the same stable-launcher contract Linux received in #2898. `buildPlist` takes a
`launcher` and execs the stable `ocx` entry instead of baking in the package-local Bun + CLI pair
(`src/service.ts:488-499`), and `installLaunchd` resolves it once through `stableLauncherEntry()` and
records it in install state (`src/service.ts:2296`). A mise or asdf upgrade that replaces the package
directory is therefore picked up on the next launchd start, with no manual `ocx service restart`.

Regression coverage is in `tests/service/service.test.ts` — the launcher is named in the plist with no
versioned path baked in, only a proof-bound Bun override survives, shell and XML metacharacters stay
quoted, and start/status compare the live job against the expected command — plus
`tests/cli/cli-version-skew.test.ts`, which also corrects the skew wording so it names which side is
actually older. That was the reversed-diagnosis problem you hit.

Thank you for identifying the external upgrade path and the downstream Copilot failure; that is what
separated this from #3450.

Closing as fixed. If a version-manager upgrade still leaves an old build serving on current `dev`,
please reopen with `ocx service status --json` and the rendered plist.
OCXEOF

gh issue close 3464 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-3464.md)"
```

Verify: `gh issue view 3464 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #3994 — 2.42.0 Plus quota exhaustion (FacuM) — duplicate

The reporter proposed this disposition in the issue body. #3795 verified `CLOSED`; the fix shipped
in v2.46.0 via #3791. Use `--reason duplicate` — this is the only item where GitHub's duplicate
reason is the accurate one.

```bash
cat > .tmp/close-3994.md <<'OCXEOF'
Closing as a duplicate of #3795 — the disposition you proposed yourself.

The incomplete-terminal quota accounting defect was fixed by #3791 and shipped in v2.46.0; `dev` is
now on the 2.49.0 line. Your evidence was captured on an installed 2.42.0, which predates that fix,
so the 18 consecutive `incomplete` terminals without failover are the known pre-fix behavior rather
than a separate defect.

Thank you for the careful sanitized aggregation, and for being explicit about what the logs do and
do not establish — particularly that they show recovery on main without proving what initiated the
account change. That precision is why this could be dispositioned without further investigation.

If you see the same streak on 2.46.0 or later, please open a fresh report with the `ocx` version and
the usage rows. That would be a real regression rather than this one.
OCXEOF

gh issue close 3994 --repo "$OCX_CLOSE_REPO" --reason duplicate --comment "$(cat .tmp/close-3994.md)"
```

Verify: `gh issue view 3994 --repo lidge-jun/opencodex --json state,closedAt,stateReason`

### Issue #3266 — per-combo attempt first-byte deadline (Veritas-7) — premise withdrawn

Re-verified: `connectTimeoutMs?: number;` at `src/types/config.ts:672`, the "deliberately NOT
connectTimeoutMs, which is a header-arrival budget" comment at `:1058`, and
`grep -rn 'attemptFirstByteTimeoutMs|requestBudgetMs' src` → no matches.

```bash
cat > .tmp/close-3266.md <<'OCXEOF'
Closing on the strength of your own corrected measurements — and thank you for correcting them
publicly twice rather than letting the first numbers stand. That is unusually careful reporting.

The final figures put timeout-shaped stalls at 19 in 134,716 attempts (0.141 per 1000, across 3 of
6 days), down from the 23 in the original post. You also established that the original 23 were not
stalls at all: 19 of them recorded a first byte, 14 of those within 60 seconds. More decisively, the
tight window contains exactly 5 attempts whose parent request still ended 200, matching the
"failover rescued 5" count you published. The existing combo failover already covered every
affected request.

On that evidence a second per-attempt timeout axis is not warranted. `connectTimeoutMs` is documented
as a header-arrival budget precisely so it is not confused with a whole-request budget
(`src/types/config.ts:672` and the note at `:1058`), and adding `attemptFirstByteTimeoutMs`
alongside it would give operators two interacting deadlines to reason about for a 0.014% event that
already self-heals.

If the stall rate changes materially — a provider that regularly holds connections without sending
headers, or a case where failover does not rescue — please reopen with the new sample and we will
revisit. The measurement methodology you built here would make that a quick decision.
OCXEOF

gh issue close 3266 --repo "$OCX_CLOSE_REPO" --reason "not planned" --comment "$(cat .tmp/close-3266.md)"
```

Verify: `gh issue view 3266 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #3255 — decouple capability and response speed (str0203) — premise disproved, residual owned by #3377

Re-verified: `src/codex/catalog/effort.ts` exists on `dev` (500 lines); #3377 is `OPEN`.
006 records this as the softest of the eight issue closes — the reporter conceded the
reclassification, but a maintainer who prefers to keep it as a tracking item for the Desktop-surface
slice has a defensible position. Drop this row first if the maintainer wants to trim.

```bash
cat > .tmp/close-3255.md <<'OCXEOF'
Closing this with the reasoning rather than as a tidy-up — and thank you for engaging with the
review so directly.

The filed defect was that model capability and response speed are represented by a single coupled
setting. That turned out not to be the case: reasoning effort and service tier are already separate
axes in the catalog at `src/codex/catalog/effort.ts`, which is why the label moved from `bug` to
`enhancement` and why you agreed with that reclassification.

What remains is a narrower and different request — exposing those existing axes independently in the
ChatGPT Desktop integration, plus a compatibility matrix for which combinations are actually valid.
That depends on per-model capability declarations, tracked in #3377, and it is better pursued there
than in a thread whose original premise was disproved.

If you would like to drive the Desktop-surface slice specifically, please open a focused issue with
the capability/speed combinations you expect to be selectable and what each should do when the
upstream does not support the pairing. That is the missing piece that would let it move.
OCXEOF

gh issue close 3255 --repo "$OCX_CLOSE_REPO" --reason "not planned" --comment "$(cat .tmp/close-3255.md)"
```

Verify: `gh issue view 3255 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #4001 — Cockpit Tools Antigravity import as Tier-2 (lidge-jun) — resolved by what shipped

Re-verified: `src/oauth/account-import/` contains `google-antigravity-adapter.ts`, `index.ts`,
`parser.ts`, `registry.ts`, `service.ts`, `types.ts`. The comment credits `@agentHits`, who
contributed the community context.

```bash
cat > .tmp/close-4001.md <<'OCXEOF'
Closing this as resolved by what already shipped and what was already decided.

File-based Antigravity import exists on `dev` today: `src/oauth/account-import/` carries a dedicated
`google-antigravity-adapter.ts` alongside the shared parser, registry, and service. The 1st-party
clipboard-paste variant was considered and closed as #3998 / #3999, and this issue's own note records
the position — official 1st-party OAuth stays separate from community tool integrations in the main
UI.

@agentHits — thank you for the detailed context on why token import and multi-account workflows
matter in daily use. It was useful and it is recorded here. The practical answer for now is that file
import works and is supported, and native multi-account pool rotation for Antigravity is being
pursued directly in #3283 / #2562 rather than through a community-tool bridge.

If a Tier-2 support tier is later formalized, that will be a documentation and policy change rather
than an open engineering item, so there is nothing further to track here.
OCXEOF

gh issue close 4001 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-4001.md)"
```

Verify: `gh issue view 4001 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #3320 — Windows non-ASCII scheduler task (chowyuan1314) — stale needs-info

Already labelled `needs-info`. The maintainer's specific ask on 2026-09-04 is unanswered. This
close does not assert the report was wrong; it asserts the evidence cannot currently distinguish it
from a working configuration.

```bash
cat > .tmp/close-3320.md <<'OCXEOF'
Closing as stale needs-info. This is not a judgment that the report was invalid.

The evidence needed to move it is a pre-repair capture from an unpatched build: the
`ocx service status --json` scheduler detail, and the `<Triggers>` block from
`schtasks /query /tn opencodex-proxy /xml`, redacted the way you already did. The SID you shared
was queried after a local compatibility patch and an `ocx service repair`, which may have rewritten
the task, so it confirms the current shape rather than the failing one.

That distinction matters because a SID-form `<UserId>` should already validate on current `dev`:
`cachedWindowsTaskUserIds()` returns both the SID and the account name, and
`windowsTaskTriggerScopeAcceptable` accepts a trigger matching either. The remaining candidates are
that identity resolution fails outright on a non-ASCII account, or that the stock task differs from
the repaired one — and only an unpatched capture separates them.

Please reopen with that capture and it will be picked up. Thank you for confirming the SID shape and
for redacting it carefully.
OCXEOF

gh issue close 3320 --repo "$OCX_CLOSE_REPO" --reason "not planned" --comment "$(cat .tmp/close-3320.md)"
```

Verify: `gh issue view 3320 --repo lidge-jun/opencodex --json state,closedAt`

### Issue #3245 — macOS Codex 0.152.0 streams disconnect (Vontean) — stale needs-info, evidence points upstream

Already labelled `upstream-tracking` and `needs-info`. Filed at 2.39.0; `dev` is on the 2.49.0 line.

```bash
cat > .tmp/close-3245.md <<'OCXEOF'
Closing as stale needs-info. This was filed against 2.39.0 and `dev` is now on the 2.49.0 line, with
substantial streaming and Responses changes in between, so a disconnect on that build cannot be
attributed to current code.

Your own transport probe is what makes this the honest outcome rather than a guess. The upgrade
received the deliberate 426, Codex logged `falling back to HTTP`, and no subsequent
`POST /v1/responses` reached the probe or the usage log. The OpenCodex Responses data plane does not
begin until that POST, so the SSE relay, terminal repair, idle timeout, and outbound connection reuse
were never reached and cannot explain the failure. The 426 to HTTP fallback is client-side, and our
half of the contract is covered by a test asserting 426 followed by HTTP 200.

`ocx config set websockets true` remains a valid opt-in for this environment.

If it still reproduces on a current Codex CLI and a current `ocx`, please reopen with an
`ocx logs --jsonl` excerpt spanning the disconnect, or a `run-request` entry captured with
`ocx debug provider on` — specifically whether a POST leaves the client at all. Thank you for the
localhost probe; it is the single most useful piece of evidence in this thread.
OCXEOF

gh issue close 3245 --repo "$OCX_CLOSE_REPO" --reason "not planned" --comment "$(cat .tmp/close-3245.md)"
```

Verify: `gh issue view 3245 --repo lidge-jun/opencodex --json state,closedAt`

### PR #4016 — route muse-spark free models to Responses API (omarjson) — duplicate of #3954

Head `3cd59118a35455952f45a4f0075559a5464031b4`, draft, `CHANGES_REQUESTED`, label `bug`,
22 behind / 1 ahead of `7dc7dc99e`.

**Independently re-verified for this doc**, because the comment makes checkable claims. I merged
`refs/pull/4016/head` onto `7dc7dc99e` in a throwaway worktree and ran `bun x tsc --noEmit`:

```
src/providers/registry.ts(3048,5): error TS1117: An object literal cannot have multiple properties with the same name.
src/providers/registry.ts(3051,5): error TS1117: An object literal cannot have multiple properties with the same name.
```

Both reversions reproduce on that same merged tree: `maxResponseBytes: 262_144` at `:1410` and
`:1568` where `dev` has `1_048_576` at `src/providers/registry.ts:1560` (from `5cd71ec91`), and
`statelessResponses: true` absent from the `opencode-go` entry where `dev` has it at `:1696`
directly under the comment "Go rejects reasoning.encrypted_content with previous_response_id
(#3838)" (from `89b69a00a`). The merge is textually clean, so the reversion is silent. Worktree
removed afterwards.

#3954 must stay open — it carries the human review thread and is the further-along branch.

```bash
cat > .tmp/close-4016.md <<'OCXEOF'
Closing as a duplicate of #3954, which carries the same `X-Session-ID` mechanism on the same file and
has the active review thread. Thank you for the report — the underlying `MissingSessionID` behavior is
worth fixing, and that work continues on #3954 rather than stopping here.

Two blockers apply to both branches and are worth carrying forward to whichever one continues.

First, typecheck. The new `modelContextWindows` and `modelInputModalities` keys duplicate declarations
that already exist later in the same `opencode-free` object literal, so `bun run typecheck` fails with
`TS1117` at `src/providers/registry.ts:3048` and `:3051` when this head is merged onto current
`dev`. This is the CodeRabbit finding from 2026-09-08, and it also makes the later empty literal win
at runtime.

Second, the branch is based on an older `dev` and silently reverts two landed fixes: the Nous catalog
bound from `5cd71ec91` (`maxResponseBytes` back to `262_144`; `dev` has `1_048_576` at
`src/providers/registry.ts:1560`) and the OpenCode Go `statelessResponses: true` policy from
`89b69a00a` (`dev` has it at `src/providers/registry.ts:1696`, added for #3838). Git merges both
cleanly because the branch is simply stale, so nothing flags the regression.

Please rebase onto current `dev` before continuing on #3954. Happy to reopen this one if you would
rather carry the work here instead.
OCXEOF

gh pr close 4016 --repo "$OCX_CLOSE_REPO" --comment "$(cat .tmp/close-4016.md)"
```

Verify: `gh pr view 4016 --repo lidge-jun/opencodex --json state,closedAt`
Also confirm the sibling survived: `gh pr view 3954 --repo lidge-jun/opencodex --json state --jq .state` → `OPEN`.

### PR #2805 — split provider registry (Ingwannu) — unrebasable

Head `2e1a0a9d6`, ready, `CONFLICTING`, +3196/-3060 across 23 files. Re-verified position:
`git rev-list --left-right --count 7dc7dc99e...refs/pull/2805/head` → **1724 behind / 2 ahead**.
Both cited provider additions exist: `615c5c62c feat(provider): add Qoder CN PAT provider` and
`124c57b1f feat(provider): add Qoder Global PAT provider`.

```bash
cat > .tmp/close-2805.md <<'OCXEOF'
Closing this as unrebasable rather than unwanted.

The head commit `2e1a0a9d6` is 1724 commits behind `dev`, and this is a 3196-line refactor of
`src/providers/registry.ts` — a file that has changed repeatedly since the branch forked, including
the Qoder Global (`124c57b1f`), Qoder CN (`615c5c62c`), and CodeBuddy provider additions. The green
CI on this head was measured against a late-August base and does not describe current `dev`.

A behavior-preserving refactor of that size cannot be carried forward by rebase; it would have to be
re-derived against the current registry, at which point it is a new change rather than this one.

The underlying goal — tighter type boundaries and a split provider registry — is still welcome. If
you would like to pursue it, please open a fresh PR against current `dev` and scope it to one seam at
a time, so each piece can be reviewed and landed before the next one drifts. Thank you for the work
that went into this.
OCXEOF

gh pr close 2805 --repo "$OCX_CLOSE_REPO" --comment "$(cat .tmp/close-2805.md)"
```

Verify: `gh pr view 2805 --repo lidge-jun/opencodex --json state,closedAt`

### PR #2462 — hubapi phase-one SaaS console (kwannz) — unlandable, redirect to #95

Head `049d55605`, draft, `CONFLICTING`, 95 files +9542/-798, no review ever submitted.
Re-verified: **2183 behind / 6 ahead**; `grep -rn 'TenantContext|tenantId' src --include '*.ts'` returns
nothing; there is no `hosted-hub.md` in `docs-site/src/content/docs/guides/` (24 guides listed, none
matching). #95 verified `OPEN`.

```bash
cat > .tmp/close-2462.md <<'OCXEOF'
Thank you for the effort here — 95 files is a serious amount of work and I do not want that to go
unacknowledged.

I am closing this as unlandable in its current form rather than as unwanted. The branch is 2183
commits behind `dev` and conflicts across all 95 files, so there is no realistic rebase path. More
importantly, the change mixes a GUI console with a product-direction shift — a `PRD.md`, an
`AGENTS.md` rewrite, landing-page components, and a new `hosted-hub` guide across several locales —
and a change of that shape needs agreement on the direction before the implementation rather than
after it.

That direction already has a home: #95, the roadmap issue for centrally hosted multi-user OpenCodex
with tenant isolation, which stays open. The most recent discussion there converged on a concrete
first slice — an immutable `TenantContext` derived only from trusted admission state, paired with one
explicit policy contract — and that is a much better place to land your thinking. Nothing in this
area exists on `dev` yet: there is no `TenantContext` or `tenantId` anywhere in `src/`.

If you would like to pursue it, please comment on #95 with the slice you want to take and open it as
a focused PR against current `dev`. I am happy to reopen this one if you rebase and want it reviewed
as it stands.
OCXEOF

gh pr close 2462 --repo "$OCX_CLOSE_REPO" --comment "$(cat .tmp/close-2462.md)"
```

Verify: `gh pr view 2462 --repo lidge-jun/opencodex --json state,closedAt`

### PR #2527 — provider-level auto-review model override (harryzhou2000) — superseded

Head `a0f35833d`, draft, `CONFLICTING`, `CHANGES_REQUESTED`, 19 files. Re-verified: **831 behind /
7 ahead**. The shipped implementation is at `src/codex/catalog/sync.ts:1689`
(`finalizeAutoReviewModelOverride`, called from the catalog write path at `:1932`), also applied by
the convergence writer at `src/codex/convergence.ts:388`, read by `readConfiguredAutoReviewModel` at
`src/codex/catalog/parsing.ts:236`, documented at
`docs-site/src/content/docs/reference/configuration/providers.md:306` including the fail-closed
handling, landed as `848a66d15`.

**This is the only wp5 item that closes a branch its author pushed to recently** (2026-09-05). Post
it last, and expect a reply. The comment names the one thing the shipped version does not do —
per-provider scoping — and invites that back as a small focused change.

```bash
cat > .tmp/close-2527.md <<'OCXEOF'
Thank you for this, and for continuing to push on it as recently as September 5 — that persistence
is why I want to be direct rather than leave it sitting.

The auto-review model override has since shipped on `dev` through a different pull request,
`848a66d15` ("ship the auto-review model override (#1688 #1225)"). The override is stamped from the
catalog write path by `finalizeAutoReviewModelOverride` at `src/codex/catalog/sync.ts:1689`, it is
also applied by the dashboard/convergence writer at `src/codex/convergence.ts:388` so the GUI path no
longer undoes it, the selector is read by `readConfiguredAutoReviewModel` at
`src/codex/catalog/parsing.ts:236`, and the behavior is documented at
`docs-site/src/content/docs/reference/configuration/providers.md:306` including the fail-closed
handling for a target that cannot be resolved.

Because of that, this branch — 831 commits behind `dev` and currently conflicting across 19 files —
would be rebased onto code that already does the job. I am closing it as superseded rather than
asking you to carry that rebase.

One thing your version raises that the shipped one does not settle: the shipped selector is read
from the root of `config.toml`, so it is global rather than provider-scoped. If per-provider
granularity is what you actually need, that is a real remaining gap and a much smaller change on top
of the current code. Please open a focused issue or PR for it and I will look at it directly.

If you think the shipped implementation misses something your branch handled, reopen this with a
rebase onto current `dev` and I will re-review.
OCXEOF

gh pr close 2527 --repo "$OCX_CLOSE_REPO" --comment "$(cat .tmp/close-2527.md)"
```

Verify: `gh pr view 2527 --repo lidge-jun/opencodex --json state,closedAt`

## Auto-closed by merge — seven issues, manual close required

`Closes #N` in a PR body fires only when the PR merges into the default branch. Every PR in this
cycle targets `dev`, so GitHub closes none of these. `AGENTS.md` states the rule directly: "GitHub
auto-closes the linked issue only when the PR merges into the default branch (`main`); PRs here
target `dev`, so close the issue manually once the change is on `dev`."

All seven verified `OPEN` at write time.

| Issue | Owning PR | WP | Author | Gate before closing |
|-------|-----------|----|--------|---------------------|
| #4003 | #4004 | wp1 | luvs01 | #4004 on `dev` |
| #4005 | #4006 | wp1 | luvs01 | #4006 on `dev` (after #4004 — shared `tests/clients/client-connect.test.ts`) |
| #3996 | #3997 | wp1b | luvs01 | #3997 on `dev`. **Do not close on #4010/#4011** — those are 2.48.0 release promotions whose file lists are the whole `main..dev` delta, which is why they appear cross-referenced |
| #4017 | #4018 | wp2 | cb8010d6 | #4018 on `dev` |
| #4007 | #4008 | wp2 | cb8010d6 | #4008 on `dev` |
| #3916 | #3920 | wp2 | cb8010d6 | #3920 on `dev`. **Judgment call** — #3920 ships a recovery command, not an automatic migration during `ocx restore`. If the maintainer reads #3916 as requiring the restore path itself to migrate or warn, keep it open with narrowed scope |
| #3894 | #3897 | wp3 | parkjs101 | #3897 on `dev`. #3897 covers only the `api-key-selection` cycle; the second cycle via `src/lib/state-store-registrations.ts:42` is out of scope by the issue's own text |

### Landing proof, run once per issue before closing

Substitute the squash-merge SHA reported by `gh pr merge`:

```bash
git -c core.hooksPath=/dev/null fetch origin dev
git merge-base --is-ancestor <squash-sha> FETCH_HEAD && echo "on dev" || echo "NOT on dev — do not close"
```

### The seven close commands

Run each only after its gate above prints `on dev`.

```bash
cat > .tmp/close-4003.md <<'OCXEOF'
Fixed on `dev` by #4004, which bounds the transaction fixture child with the existing 15-second
budget and `SIGKILL`, rejects spawn errors, nonzero exits, and signals before parsing output, and
removes both temporary homes when the child or its output fails.

Closing manually because pull requests here target `dev` rather than the default branch, so GitHub
does not auto-close on merge.
OCXEOF
gh issue close 4003 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-4003.md)"

cat > .tmp/close-4005.md <<'OCXEOF'
Fixed on `dev` by #4006. A journal without recorded injected-state hashes no longer authorizes
whole-file restoration: a changed config or profile lacking its own injection hash is preserved along
with the journal, the restore reports an explicitly unverified result through native restore and
reconcile, and routed reinjection verifies the retained snapshot before writing. All eight reported
cases are covered by regressions that fail against the previous source.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 4005 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-4005.md)"

cat > .tmp/close-3996.md <<'OCXEOF'
Fixed on `dev` by #3997, which reuses the existing caller-owned-main resolver when the selected
stored Pool account is cooling down and no recovery probe lease is available. Exact account bindings,
model entitlement checks, the main quota policy, Pool selection, and cooldown state are all
preserved.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 3996 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-3996.md)"

cat > .tmp/close-4017.md <<'OCXEOF'
Fixed on `dev` by #4018. `parseUsageQuota` now emits both `GPT-5.3-Codex-Spark 5h` and
`GPT-5.3-Codex-Spark Weekly` as model-scoped windows, and the visibility filter hides or reveals both
together instead of collapsing the five-hour window into a generic account window.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 4017 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-4017.md)"

cat > .tmp/close-4007.md <<'OCXEOF'
Fixed on `dev` by #4008. `mergeAccountQuota` now retains `customWindows` when a partial header
update omits them, replaces them when they are explicitly supplied (including an empty list), and
clears them on a cache clear — the three behaviors this issue asked for, each pinned by a regression.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 4007 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-4007.md)"

cat > .tmp/close-3916.md <<'OCXEOF'
Addressed on `dev` by #3920, which adds `ocx recover-history --ocx-compaction <thread-id> --yes`.
It lowers only proxy-owned compactions inside `compacted.payload.replacement_history`, requires an
explicitly named thread plus `--yes`, and backs up before an atomic replace, so an affected thread
becomes replayable on the native backend again.

To be precise about scope: this is an explicit recovery command rather than an automatic migration
during `ocx restore`. Your expected-behavior clause admits either, so I am closing on the recovery
path. If you want `ocx restore` itself to migrate or warn, please say so and I will reopen with that
narrower scope.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 3916 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-3916.md)"

cat > .tmp/close-3894.md <<'OCXEOF'
Fixed on `dev` by #3897, which extracts the pure selection-capture helper so `src/router.ts` no
longer imports `src/providers/api-key-selection.ts` directly, with a compatibility re-export left in
place — the shape your "Possible after" sketch proposed, including the boundary coverage you asked
for.

As you scoped it, the second cycle through `src/lib/state-store-registrations.ts` is untouched and
remains out of scope here.

Closing manually because pull requests here target `dev` rather than the default branch.
OCXEOF
gh issue close 3894 --repo "$OCX_CLOSE_REPO" --reason completed --comment "$(cat .tmp/close-3894.md)"
```

Verify each: `gh issue view <N> --repo lidge-jun/opencodex --json state,closedAt`

Batch verification for all seven at once:

```bash
for n in 4003 4005 3996 4017 4007 3916 3894; do
  gh issue view "$n" --repo "$OCX_CLOSE_REPO" --json number,state,closedAt \
    --jq '"\(.number)\t\(.state)\t\(.closedAt)"'
done
```

## Verification gates

wp5 has no CI, no tests, and no tree change, so its gates are state assertions.

**Before any close (per item):**

1. `gh issue view <N> --repo lidge-jun/opencodex --json state --jq .state` → `OPEN`. If already
   `CLOSED`, skip and record it in the ledger as pre-closed.
2. For the two fixed-on-dev issues, re-assert the anchor on a fresh fetch, because the whole comment
   rests on it:
   ```bash
   git -c core.hooksPath=/dev/null fetch origin dev
   git grep -n 'sourcePreservingYaml' FETCH_HEAD -- src/integrations/registry.ts | head
   git grep -n 'stableLauncherEntry()' FETCH_HEAD -- src/service.ts | head
   ```
3. For #3255 and #2462, confirm the redirect target is still open:
   `gh issue view 3377 --repo lidge-jun/opencodex --json state --jq .state` and same for `95`.
4. For #4016, confirm #3954 is still `OPEN` so the underlying report survives.

**After each close:** the verification command in that item's section. A close is recorded in the
ledger only after `state` reads `CLOSED` and `closedAt` is non-null.

**After the batch:** `rm -f .tmp/close-*.md`. These are drafts about contributors' work and there is no
reason to leave them lying in the tree.

**Full-batch reconciliation:**

```bash
for n in 3989 3464 3994 3266 3255 4001 3320 3245; do
  gh issue view "$n" --repo "$OCX_CLOSE_REPO" --json number,state,closedAt \
    --jq '"issue \(.number)\t\(.state)\t\(.closedAt)"'
done
for n in 4016 2805 2527 2462; do
  gh pr view "$n" --repo "$OCX_CLOSE_REPO" --json number,state,closedAt \
    --jq '"pr    \(.number)\t\(.state)\t\(.closedAt)"'
done
```

Expected: 12 rows, all `CLOSED` with a timestamp.

## Ledger rows

Append to 070 (closeout) and mirror the count into 060. One row per item, filled only after its
verification command confirms the state.

```
| <#N> | <issue\|pr> | wp5 | <CLOSE reason> | <author> | <closed-at UTC> | <evidence anchor> | <verify output> |
```

Header and prefilled rows — the `Closed at` and `Verified` columns stay empty until executed:

| Item | Kind | WP | Disposition | Author | Closed at | Evidence anchor | Verified |
|------|------|----|-------------|--------|-----------|-----------------|----------|
| #3989 | issue | wp5 | CLOSE — fixed on dev | rrmlima | | `src/integrations/registry.ts:193`; `a0e794d1d` via #4030 | |
| #3464 | issue | wp5 | CLOSE — fixed on dev | garysassano | | `src/service.ts:497`, `:2296` | |
| #3994 | issue | wp5 | CLOSE — duplicate of #3795 | FacuM | | #3791 in v2.46.0; reporter-declared | |
| #3266 | issue | wp5 | CLOSE — premise withdrawn | Veritas-7 | | 19/134,716; `src/types/config.ts:672`, `:1058` | |
| #3255 | issue | wp5 | CLOSE — premise disproved, residual in #3377 | str0203 | | `src/codex/catalog/effort.ts` | |
| #4001 | issue | wp5 | CLOSE — shipped + decided | lidge-jun | | `src/oauth/account-import/`; #3998/#3999 | |
| #3320 | issue | wp5 | CLOSE — stale needs-info | chowyuan1314 | | 2026-09-04 ask unanswered | |
| #3245 | issue | wp5 | CLOSE — stale needs-info, upstream | Vontean | | reporter probe: no POST reached proxy | |
| #4016 | pr | wp5 | CLOSE — duplicate of #3954 | omarjson | | TS1117 at `registry.ts:3048`/`:3051`; reverts `5cd71ec91`, `89b69a00a` | |
| #2805 | pr | wp5 | CLOSE — unrebasable | Ingwannu | | 1724 behind; `615c5c62c`, `124c57b1f` | |
| #2462 | pr | wp5 | CLOSE — unlandable, → #95 | kwannz | | 2183 behind; no `TenantContext` in `src/` | |
| #2527 | pr | wp5 | CLOSE — superseded by `848a66d15` | harryzhou2000 | | `sync.ts:1689`, `convergence.ts:388`, `parsing.ts:236` | |

Auto-close rows, appended as each owning PR lands:

| Item | Kind | WP | Disposition | Owning PR | Landed SHA | Closed at | Verified |
|------|------|----|-------------|-----------|------------|-----------|----------|
| #4003 | issue | wp5 | CLOSE on merge | #4004 | | | |
| #4005 | issue | wp5 | CLOSE on merge | #4006 | | | |
| #3996 | issue | wp5 | CLOSE on merge | #3997 | | | |
| #4017 | issue | wp5 | CLOSE on merge | #4018 | | | |
| #4007 | issue | wp5 | CLOSE on merge | #4008 | | | |
| #3916 | issue | wp5 | CLOSE on merge (scope caveat) | #3920 | | | |
| #3894 | issue | wp5 | CLOSE on merge | #3897 | | | |

wp5 contribution to the coverage target: **12 direct** + **7 merge-linked** = 19 of the 25–30 goal.

## Rollback

Every wp5 action is reversible, which is why the phase is safe to run before the merge phases
complete.

- **Wrong close.** `gh issue reopen <N> --repo lidge-jun/opencodex` or
  `gh pr reopen <N> --repo lidge-jun/opencodex`. A reopened PR keeps its head branch as long as
  `--delete-branch` was never passed, which is why this doc forbids that flag.
- **Wrong comment text.** The comment cannot be unposted cleanly. Edit it with
  `gh issue comment <N> --edit-last --body-file .tmp/close-<N>.md` (same for `gh pr comment`), or
  post a short correction. Prefer editing — a deleted comment leaves a confusing thread.
- **Batch abort mid-run.** Items are independent; stop and the completed closes stand. Record the
  partial state in the ledger rather than reopening for tidiness.
- **A merge is reverted after its issue was auto-closed.** Reopen the issue and note the revert SHA
  in the thread. This applies only to the seven merge-linked rows.
- **Contributor objects to a close.** Reopen without argument. #2527 and #3255 are the two most
  likely, and both comments already invite exactly that.

## What was NOT RUN

- `bun run test` and bare `bun test`: **NOT RUN.** Out of lane scope and forbidden by the task.
- `bun run typecheck` on `dev`: **NOT RUN.** `bun x tsc --noEmit` was run once, only on a
  throwaway merge of `refs/pull/4016/head` onto `7dc7dc99e`, to confirm the TS1117 line numbers
  quoted in the #4016 comment. That scratch worktree was removed
  (`git worktree remove --force /tmp/ocx249-wp5/wt`).
- `bun run privacy:scan`, `bun run lint:gui`, `bun run build:gui`: **NOT RUN.** wp5 changes no files.
- Focused `bun test` files: **NOT RUN for wp5.** No item here has a test to run; the closes assert
  repository state, not behavior. Focused counts quoted in the comments for #3464 and #3989 are
  carried from lane 004, not re-executed.
- Hosted CI: **NOT DISPATCHED.** wp5 has no head to run CI against.
- **No comment posted, no issue or PR closed, no `.tmp/` file created.** Every command in this
  document is unexecuted and waits on maintainer authorization of wp5.
- The eight issue closes were verified as `OPEN` and their code anchors re-read at `7dc7dc99e`, but
  the *judgment* in each comment — particularly the two `needs-info` closes and #3255 — is carried
  from lanes 004 and 005 and was not independently re-derived from the full issue threads.

## Method

Sources read: 000, 006, 002 (§#4016, §Issues), 004 (§#3989 #3464 #3994 #3320 #3245), 005 (§#2805
#3266 #4001 #3255), 008 (§#2527 #2462), plus 001 and 003 for the auto-close comment drafts.
Anchors re-verified in the read-only research worktree `/tmp/ocx-249.xGQnxl/wt` at
`7dc7dc99e65268bc8764e19840952256b030bce9`, re-fetched immediately before writing (`origin/dev`
unchanged). Live state for all 15 issues and 11 PRs re-read with `gh` at write time. The research
worktree index was never modified; the one scratch worktree created for the #4016 typecheck was
removed.

