# Public OpenCodex fork: pin the daily tree to released `main`

Date: 2026-08-21  
Status: draft pending user review  
Scope: change the fork’s **vendor pin** from `upstream/dev` to `upstream/main` for the trees we run and publish. Overlay layout, `src/fork/` seam, conflict classes, and “agents recommend / humans land `origin/main`” stay as in `2026-08-21-fork-sync-design.md`.

This is a **fork-owned** document. It must not be opened as an upstream PR.

## Goal

Run the last **released** OpenCodex (`upstream/main`, currently `v2.29.0`) every day, plus:

- the short `fork:` overlay (playbook, `src/fork/` registration);
- the still-open upstream PRs we actually need (Antigravity stack #2068–#2071, subagent roles #2257).

Keep public `origin/main` a **clean release pin** (released code + overlay only). Never put the unreleased PR stack on the public default branch. Never force-push `origin/main`.

Success metric: `git log vendor/main..origin/main` is only `fork:` overlay commits. The checkout we run is `run/main`, rebuilt from that pin plus selected `feat/*`.

## Decisions (already made)

- Daily **base** is `upstream/main`, not `upstream/dev`.
- Daily **features** still include open PRs (replayed onto the release pin).
- Public `origin/main` stays overlay-only. Disposable `run/main` carries the PR stack.
- Upstream PRs stay targeted at **`dev`**. Do not retarget them to `main` (upstream rejects that).

## Non-goals

- Force-pushing `origin/main`.
- Opening upstream PRs from `origin/main`, `overlay`, or `run/main`.
- Cutting `feat/*` from `vendor/main` (that trips the “on `main` but far behind `dev`” gate).
- Tracking `upstream/preview` as a third daily pin.
- Keeping `run/dev` as the daily checkout.
- Whole-tree `git merge -X ours` / `-X theirs`.

## Why two vendor branches

Upstream `dev` is the only integration line. `main` moves only on maintainer promotion. We need both:

- **`vendor/main`** — what we run and what we publish.
- **`vendor/dev`** — what we branch from when sending PRs upstream.

A PR head whose ancestry sits on `main` while far behind `dev` is rejected. `feat/*` therefore stay based on `vendor/dev`. We **replay** those patches onto `run/main` for local use.

## Branch lanes

| Branch | Base | Role | Rewritten? | Public default? |
|---|---|---|---|---|
| `vendor/main` | `upstream/main` | FF-only release mirror | No (FF only) | No |
| `vendor/dev` | `upstream/dev` | FF-only; **only** for `feat/*` → upstream PRs | No (FF only) | No |
| `overlay` | `vendor/main` | Linear `fork:` stack (playbook / `src/fork`) | Yes (rebase) | No |
| `origin/main` | overlay via merge-only sync PRs | Public default: released + overlay | No | Yes |
| `feat/…` | `vendor/dev` | Open upstream PRs | Yes until landed | No |
| `run/main` | rebuilt, not a merge train | Daily driver: `vendor/main` + overlay + selected `feat/*` | Yes | No |
| `run/dev` | retired as daily | Optional later if we need to test against integration | Yes | No |
| `sync/upstream-YYYYMMDD` | from `origin/main` | Throwaway: merge `vendor/main`, CI, PR into `origin/main` | Discarded | No |

Rules:

- Never commit overlay work on `vendor/main` or `vendor/dev`.
- Never open an upstream PR from `origin/main`, `overlay`, or `run/main`.
- After a `feat/*` is **on `vendor/main`** (promoted into a release), drop it from `run/main`. Being on `vendor/dev` only is **not** enough to drop it — that is the unreleased gap we are replaying.
- After upstream absorbs an overlay idea, drop that `fork:` commit from the overlay.
- Never force-push `origin/main`. Force-push `run/main` and rebase `overlay` as needed.

## Overlay

Same layout as the previous spec: `src/fork/`, `tests/fork/`, `docs/fork/`, one synchronous `registerFork()` in `src/server/index.ts` after Lab activation. Core files `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts` must not import `src/fork/`.

Today’s overlay is two `fork:` commits currently sitting on `vendor/dev`. Implementation rebases them onto `vendor/main`. If the `index.ts` seam conflicts, keep the one synchronous call immediately after the Lab activation block.

## Sync `origin/main` with a new release

Cadence: fetch when we work; merge when **`upstream/main` moves** (a release), and immediately for security/auth on that branch. Do not chase `upstream/dev` into `origin/main`.

```text
git fetch upstream --prune
fast-forward vendor/main to upstream/main
fast-forward vendor/dev to upstream/dev   # PR base only; not merged into origin/main
create sync/upstream-YYYYMMDD from origin/main
merge --no-ff vendor/main into the sync branch
agents classify + recommend; human confirms shared/auth hunks
focused tests; typecheck if routing/config/server
open/merge sync PR on the fork into origin/main
rebase overlay onto vendor/main
drop overlay commits absorbed by the release
rebuild run/main
```

Three-way merge for that sync: base = last common; **ours** = `origin/main`; **theirs** = `vendor/main`.

`docs/fork/OWNED.md` path classes stay. Only the “theirs” vendor branch name changes (`vendor/main` instead of `vendor/dev`).

Never `git merge -X ours` across the tree. Agents analyze, recommend, and test. Humans land `origin/main`.

## Rebuild `run/main`

Disposable. Not the public default.

```text
reset run/main to vendor/main
apply overlay (cherry-pick vendor/main..overlay, or merge origin/main if that already has the overlay)
merge selected feat/* PR heads in stack order (quota → wire → failover → cooldowns → subagent)
force-push run/main (this branch is rebuilt)
```

Selected `feat/*` at the time of this spec (GitHub still targets `dev`):

- #2068 live quota RPC and geoblock
- #2069 process-local account cooldowns
- #2070 Claude CCA wire fidelity
- #2071 CCA host failover
- #2257 named subagent role catalog (include its GUI stack if that is how the PR is filed)

Apply in stack order (quota → wire → failover → cooldowns → subagent), same as the current `run/dev` rebuild.

If a patch does not apply onto current `vendor/main` (it was written against newer `dev`):

- Resolve on `run/main` only, or replay onto a local `replay/*` branch based on `vendor/main`.
- Leave the GitHub PR head on `vendor/dev`.
- Do not retarget the upstream PR to `main`.
- Do not silently omit a selected PR; record the conflict in the rebuild notes. If the operator then drops it, that is an explicit decision.

Stop including a `feat/*` once it is contained in `vendor/main` (`git cherry` equivalent or merged-and-promoted).

## Public `origin/main` first landing

`origin/main` is already the upstream-shaped release tip (`v2.29.0`) without overlay. First overlay landing is a **normal merge PR** into `origin/main` (cherry-pick or merge the `fork:` commits). No force-push. Confirm with `gh repo view --json defaultBranchRef` before assuming the default branch name.

Local `main` that still points at an older promotion is unused as a daily tree; after the first sync PR, local `main` tracks `origin/main`.

## Testing during sync and rebuild

- Overlay / fork seam: `bun test tests/fork/register.test.ts` and `bun test tests/core-lab-boundary.test.ts`.
- Replayed Antigravity PRs: focused `bun test tests/antigravity-quota.test.ts` (and matching google/CCA tests that those PRs already use).
- Subagent roles: focused tests those PRs already add.
- Shared runtime, routing, config, server after a release merge: `bun run typecheck` and `bun run test`.
- Logging/credentials: `bun run privacy:scan`.
- Do not claim done without command output.

## Implementation artifacts (after this spec is approved)

- Amend `docs/fork/README.md` — vendor pin is `upstream/main`; `run/main` is the daily checkout; `vendor/dev` remains for `feat/*`.
- Amend `docs/fork/OWNED.md` — theirs = `vendor/main`.
- Amend `.cursor/skills/opencodex-fork-sync/SKILL.md` — same commands with `vendor/main` / `run/main`.
- Point `2026-08-21-fork-sync-design.md` at this pin (overlay/seam rules remain).
- Git: create `vendor/main` at `upstream/main`; rebase `overlay` onto it; sync PR into `origin/main`; rebuild `run/main`; stop using `run/dev` as the daily checkout.

## Spec self-review

- No TBD/TODO placeholders.
- `origin/main` is never force-pushed; `overlay` and `run/main` may be rewritten.
- Open PRs stay on `dev`; only `run/main` carries their patches on a release base.
- A patch on `vendor/dev` but not `vendor/main` stays in the `run/main` selection list.
- Agents recommend; humans land `origin/main`.
