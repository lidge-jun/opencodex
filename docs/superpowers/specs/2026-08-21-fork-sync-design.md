# Public OpenCodex fork: upstream sync and overlay — Design

Date: 2026-08-21  
Status: overlay/seam rules still apply; **daily-driver pin superseded** by `2026-08-21-fork-daily-main-pin-design.md` (`vendor/main` + `run/main`, not `vendor/dev` as the tree we run).  
Scope: long-lived public fork of `lidge-jun/opencodex` that stays upgradeable while carrying local behavior that is hard to land upstream.

This is a **fork-owned** document. It must not be opened as an upstream PR.

## Goal

Run a public GitHub fork with:

- a **clean, manageable history** (short, curated delta vs upstream — not a rewritten default branch);
- **regular upstream sync** with minimal recurring conflicts;
- **freedom to change anything**, including work upstream automations/maintainers reject;
- **agent-assisted** conflict analysis, tests, and merge recommendations;
- continued ability to send **clean PRs upstream** from isolated topic branches.

Success metric: `git log vendor/dev..main` is a short, named patch list (ideally well under ~20 commits), not a mix of 65 local merges sitting 123 commits behind `upstream/dev`.

## Non-goals

- Force-pushing the public default branch (`main`).
- Treating in-flight stacked PRs as the overlay (those stay on `feat/*`).
- A hosted multi-tenant product.
- Whole-tree `git merge -X ours` / `-X theirs`.
- Committing secrets, `.env`, runtime DBs, or machine-local state.

## Remotes (already true in this checkout)

- `upstream` → `https://github.com/lidge-jun/opencodex.git`
- `origin` → `https://github.com/yansigit/opencodex.git` (public fork)

Daily vendor pin is **`upstream/main`** (see `2026-08-21-fork-daily-main-pin-design.md`). Keep `vendor/dev` as a fast-forward of `upstream/dev` only to cut `feat/*` PRs. Do not merge `upstream/dev` into `origin/main`.

## Branch lanes

| Branch | Role | Rewritten? | Public default? |
|---|---|---|---|
| `vendor/dev` | Exact fast-forward of `upstream/dev` | No (FF only) | No |
| `main` | Public daily driver: vendor + curated overlay | No | Yes |
| `overlay` | Optional linear local-forever stack; rebase allowed | Yes | No |
| `feat/…` | One change; PRs to upstream cut from `vendor/dev` | Yes until landed | No |
| `run/dev` | Disposable: vendor + selected unmerged `feat/*` + overlay | Yes (rebuilt) | No |
| `sync/upstream-YYYYMMDD` | Throwaway merge branch; CI; then merge to `main` | Discarded after | No |
| `archive/mixed-dev-YYYYMMDD` | Snapshot of the pre-split mixed `dev` | Frozen | No |

Rules:

- Never commit overlay work on `vendor/dev`.
- Never open an upstream PR from `main`, `overlay`, or `run/dev`.
- After upstream absorbs a patch, **drop it from the overlay** so the next merge is empty, not a self-conflict.
- In-flight PRs are not `main`. To *run* them, rebuild `run/dev`.

## Overlay layout (minimize future conflicts)

Prefer **new files** over editing upstream hotspots.

1. **Fork-owned prefix:** `src/fork/` (runtime), `tests/fork/` (tests), `docs/fork/` (this process). Core must not import `src/fork/` except through **one registration seam** (same idea as Lab: composition root installs a slot; default installs run no fork code).
2. **Tiny seams only** in upstream files (`src/server/index.ts` or an existing slot). The seam calls `src/fork/register.ts` if present. Do not grow `src/adapters/google.ts` / `src/server/responses/core.ts` with fork-only behavior when a wrapper or slot would do.
3. **Shared hotspots** (today: `src/adapters/google.ts`, `src/adapters/google-http.ts`, `src/server/responses/core.ts`, Antigravity quota modules): allowed when the feature *is* a wire-protocol change, but each overlay commit must be one concern, and agents treat these as **always-ask**.
4. **Do not overlay** translated `docs-site` locales, lockfiles as hand-edits, or CI workflows unless the overlay is itself CI for the fork. Lockfile: take upstream, then regenerate if `src/fork` added a dependency.
5. **Commit shape on the overlay:** one topic per commit, no merge commits inside `git log vendor/dev..main`. Message prefix `fork:` for local-forever, keep `feat:`/`fix:` only on `feat/*` intended for upstream.

`docs/fork/OWNED.md` lists paths as `fork-owned` | `shared-hotspot` | `upstream-owned`. Agents read it before resolving.

## Sync flow

Cadence: fetch daily; merge at least weekly; immediately for security/auth/CI; max drift ~7–10 days.

```text
git fetch upstream --prune
fast-forward vendor/dev to upstream/dev
create sync/upstream-YYYYMMDD from main
merge --no-ff vendor/dev into the sync branch
agents classify + recommend; human confirms shared/auth hunks
apply, focused tests, typecheck if routing/config/server
open/merge sync PR on the fork into main
drop overlay commits absorbed by upstream
```

Enable `git rerere` (`rerere.enabled=true`) so repeat hunks replay.

Never `git merge -X ours` across the tree. If the merge is a disaster: abort, shrink overlay, retry. Do not land a bad resolution on `main`.

`run/dev` rebuild (not a long-lived merge train):

```text
reset run/dev to vendor/dev
cherry-pick or merge selected feat/* that are not in vendor yet
apply overlay delta (commits in vendor/dev..main)
force-push run/dev (README: this branch is rebuilt)
```

Stop including a `feat/*` once it is in `vendor/dev`.

## Conflict policy (both sides changed the same lines)

Three-way merge: base = last common; ours = `main`; theirs = `vendor/dev`.

| Class | Default | Notes |
|---|---|---|
| `upstream-owned` | Take theirs | Re-apply fork intent as a **new small commit** only if still needed |
| `fork-owned` | Take ours | Files only the fork added |
| `shared-hotspot` | Manual / agent report | Keep upstream control flow; re-fit fork behavior; never “accept all ours” |
| Lockfiles | Take theirs | Regenerate if overlay added deps |
| File deleted by them, edited by us | Decide restore vs abandon | Record in merge message |
| Rename | Follow new path | `--find-renames`; do not keep a zombie old path |
| Upstream shipped the same idea | Drop ours | Duplicate patches cause later “impossible” conflicts |
| Refactor of a patched function | Port behavior | New `fork:` commit on the new shape; forget the old diff |

## Agent-assisted sync

Agents **analyze, recommend, test**. They do not autonomously merge `main`.

| Role | Job | Must not |
|---|---|---|
| Coordinator | Fetch, open sync branch, list conflicts, dispatch, assemble decision table, push after human confirm | Resolve hunks itself; whole-tree `-X ours` |
| File/subsystem worker | One conflict domain: 3-way intent, 2–3 options, recommendation, exact tests | Touch other domains; commit `main` |
| Test worker | Run named `bun test` paths; typecheck when routing/config/server/shared runtime | Claim green without command output |
| Absorbed-patch worker | Compare overlay to upstream; drop duplicates | Keep a patch because we wrote it first |

Parallelize independent domains. **Serialize** `src/adapters/google.ts` and `src/server/responses/core.ts`.

Per-conflict report (required): file/hunk; upstream intent; overlay intent; classification; options (theirs+reapply · ours · true merge · drop absorbed · extract to `src/fork/`); recommendation (correctness, then features, then fewer future conflicts); exact test commands.

Auto-propose, still show: whitespace, comments, locale-only, lockfile theirs+reinstall.  
Always wait: auth, OAuth, adapters, `responses/core.ts`, workflows, behavior changes.  
Never: skip failing tests; force-push `main`; delete a fork feature to “make the merge clean” without an explicit drop decision.

Playbook: Cursor skill `opencodex-fork-sync` (implementation after this spec is approved).

## Testing during sync

- Touched adapter/provider: `bun test tests/<matching>.test.ts` (e.g. `google-hardening`, `google-antigravity-wire`, `antigravity-quota`, `cursor-images`).
- Shared runtime, routing, config, server: `bun run typecheck` and `bun run test`.
- Logging/credentials: `bun run privacy:scan`.
- Do not claim the sync is done without the command output.

## One-time split (current mixed `dev`)

Current failure mode: `dev` is **ahead 65 / behind 123** vs `upstream/dev`. Those 65 commits are mostly in-flight Antigravity/Cursor/PR merges, not a curated overlay.

1. Tag/branch `archive/mixed-dev-2026-08-21` at current `dev` so nothing is lost.
2. Create `vendor/dev` at `upstream/dev` (FF-only thereafter).
3. Classify each commit in `upstream/dev..archive/mixed-dev-…`:
   - **already on upstream** (different SHA) → drop;
   - **still an open `feat/*` PR** → leave on the topic branch only;
   - **local-forever** → cherry-pick onto a new `main` (or `overlay`) in small `fork:` commits.
4. Point public default `main` at `vendor/dev` + only the local-forever picks. Do not make mixed `dev` the public default.
5. Optionally build `run/dev` from vendor + wanted `feat/*` for a daily-driver that includes unmerged PRs.
6. Document remotes and lanes in `docs/fork/README.md` on `main`.

No force-push of `origin/main` if GitHub `main` already has consumers; prefer a new default-branch switch after a normal push of the rebuilt history, or a merge commit that replaces the tree via a reviewed sync PR. Prefer **new `main` from vendor** if `origin/main` is still the upstream-shaped release branch (currently behind 218) — confirm with `gh repo view` default branch before switching.

## Implementation artifacts (after spec approval)

- `docs/fork/README.md` — operator summary (lanes, sync, `run/dev`).
- `docs/fork/OWNED.md` — path classifications.
- `.cursor/skills/opencodex-fork-sync/SKILL.md` — agent playbook.
- One-time git commands in a plan (no destructive reset of unique `feat/*` worktrees).
- Optional: `rerere` enabled in local repo only (do not change global git config unless the user asks).

## Spec self-review

- No TBD/TODO placeholders.
- Default branch is never rewritten; overlay/`run/dev` may be.
- Agents recommend; humans land `main`.
- Mixed `dev` is archived, not used as the public identity.
