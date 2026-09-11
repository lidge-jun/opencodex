# Dispatch packet — L4 (revision 5)

Round unit: `devlog/_plan/260911_lane_dispatch_round` on `dev`. Base freeze: `origin/dev` `6d3ad12e3` (2.51.0).
Five audit rounds shaped this packet. The last one was a seven-lane feasibility check that asked whether each stack is implementable inside its owned paths; three lanes came back with gaps, and the fixes are folded here. `010_lane_partition.md` is the authoritative ownership list; `130_wp4_feasibility.md` records why each path was granted.


## Shared frame

**Repository.** Your worktree is named in your packet, already checked out on your lane branch, cut
from `origin/dev` `6d3ad12e3` (2.51.0). Work only there. Do not add, move, or remove a worktree.

**Loop.** Run `$codexclaw:cxc-loop` as HOTL for your lane: one work-phase per issue, in order. Your
goal ends when your last PR is green and reported, not when the code looks right.

**Subagents.** Unlimited `xai/grok-4.6` subagents, read-only, spawned with `spawn_agent`
(`model: "xai/grok-4.6"`). Use them to reproduce, to read the call sites you are about to change, to
find a second caller of a helper you are touching, and to review your staged diff adversarially
before you push. A finding enters your work only with an exact `path:line` anchor. Subagents never
write, commit, push, or call a mutating `gh`. Treat a `fail` verdict the way this round did: fold it
in and re-audit. This packet is at revision 3 because two audit rounds rejected revisions 1 and 2.

**MUST NOT.**

- No local product suite: no `bun test`, no `bun run test`, no `bun run test:changed`, no
  `bun run typecheck`, no `bun run build:gui`, no `bun install`. Report them as `NOT RUN`.
- No merge, no release, no force-push to a shared branch, no direct push to `dev`.
- No path outside your owned list, including paths a carried PR happens to touch. Dropping a hunk
  from a carried PR is expected; report what you dropped.
- No locale key in `gui/src/i18n/*`. If you need one, stop and report.
- No security write-up in `devlog/`; scratch space only, per `AGENTS.md`.

**MUST.**

- Prefix every mutating git command with `git -c core.hooksPath=/dev/null`. This repository's hooks
  can start a GUI install, typecheck, and build, which the no-local-suite rule forbids.
- Push with `--no-verify`.
- Write the focused regression test `AGENTS.md` requires for a behaviour change, in the domain
  directory beside the existing tests for that subsystem, and register it in both
  `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`. You
  will not run it; hosted CI will. Those two maps are append-only and other lanes are adding to them
  too; the orchestrator resolves the conflicts at merge, so do not skip the entry.
- Fill every section of `.github/PULL_REQUEST_TEMPLATE.md` and put `Closes #<issue>` in the body. In
  **Verification**, state that the local suite, typecheck, and build were `NOT RUN` by operator
  instruction and that hosted CI on the exact pushed head is the proof.
- When you carry another author's PR, add a `Co-authored-by` trailer in a branch commit. Resolve the
  address with `gh api users/<login> --jq '.id'` and use `<id>+<login>@users.noreply.github.com`.
- Keep a devlog unit under `devlog/_plan/260911_l<N>_<slug>/`.

**Stacking.** First PR targets `dev`; the second targets the first PR's head branch, the third the
second. Retarget a child to `dev` after its parent lands. No native GitHub stacks.

**Decisions already made for you.** Both audit rounds found items where the issue left a real choice
open. Those calls are recorded in your packet in bold. Implement the recorded decision; if you think
it is wrong, report the reason and stop.

**Stop conditions.** Stop and report when the fix needs a path you do not own, when it needs a policy
no issue has fixed, when a locale key is unavoidable, or when hosted CI fails for a reason outside
your diff.

**Report format.** Per PR: number, exact head SHA, CI run id and conclusion, the issue it closes, the
co-authors credited, the hunks you dropped from a carried PR, and any decision you made. Say
`NOT RUN` for local checks.

**Decision boundary.** You do not merge, do not close another author's PR, and do not rank your lane
against another. When your last PR is green, report and stop.

## L4 — service, update, CLI, and connected client

Worktree `~/.codex/worktrees/260911-l4/opencodex`, branch `codex/260911-l4-service-cli`.

Owned: directories `src/update/`, `src/cli/`, `src/client/`; files `bin/ocx.mjs`, `src/cli.ts`,
`src/service.ts`, `src/config/pending-teardown.ts`, `src/lib/bun-runtime.ts`,
`src/lib/package-tree-integrity.ts`, `src/lib/process-control.ts`, `src/codex/catalog/effort.ts`,
`src/codex/cli-install-provenance.ts`, `docs-site/src/content/docs/getting-started/installation.md`.

Your stack is #4202 → #4169 → #4207. **#4204 was removed from the round** by the feasibility audit:
binding the clamp to the Desktop runtime needs `codex/runtime.ts:573`, `catalog/bundled.ts:239`, and
`catalog/sync.ts:1945`, because the catalog probes one selected runtime and no caller passes a
consumer identity. Resolving a catalog per consumer is a design decision this round does not make.

1. **#4202 — global pnpm installations cannot self-update.** Carry PR #4203 by `oliver-mee` (open
   **draft**, `CHANGES_REQUESTED`, 36 files). **Decision: the keep-set is exactly** `bin/ocx.mjs`,
   `src/cli.ts`, `src/cli/launcher-context.ts`, `src/config/pending-teardown.ts`,
   `src/lib/bun-runtime.ts`, `src/lib/package-tree-integrity.ts`, `src/service.ts`, every file under
   `src/update/`, the tests `tests/ci-workflows/install-scripts.test.ts`,
   `tests/cli/ocx-launcher-runtime.test.ts`, `tests/cli/ocx-launcher-source.test.ts`,
   `tests/update/update-badge.test.ts`, `tests/update/update-job.test.ts`,
   `tests/update/update-pnpm.test.ts`, `tests/update/update-stop-first.test.ts`, the two test-layout
   maps, and `docs-site/src/content/docs/getting-started/installation.md`. **Drop** `README.md`,
   `structure/01_runtime.md`, `structure/06_docs-and-release.md`,
   `docs-site/src/content/docs/getting-started/for-agents.md`, and
   `docs-site/src/content/docs/reference/cli/lifecycle.md`.
2. **#4169 — every stop refusal is reported as a `CODEX_HOME` ownership mismatch,** hiding
   `respawnable_service`. Carry PR #4170 by `yeongjunyoo` (open **draft**, `REVIEW_REQUIRED`); it
   touches `src/cli/index.ts` and `src/lib/process-control.ts`, both yours, plus its two tests
   `tests/lib/process-control-graceful.test.ts` and `tests/providers/xai/grok-lifecycle.test.ts`,
   which you keep.
3. **#4204 — Windows: a stale persisted CLI 0.135.0 strips max/ultra while Desktop runs 0.153.4.**
   The clamp is `src/codex/catalog/effort.ts:441`. #4178 by `luvs01` is open, not a draft, full CI
   green, and owns `src/codex/cli-install-provenance.ts`: if it lands first, rebase onto it;
   otherwise keep out of that file and say so.
4. **#4207 — the connected catalog reports success while the local Codex CLI rejects unsupported
   reasoning levels.** Same clamp as #4204, which is why both are here; client side is
   `src/client/hub-client.ts:145`, `src/client/connect.ts:542`, `src/cli/connect.ts:187`.
   **Decision: fail closed — block local readiness rather than reporting success** when the
   projection is not compatible with the local client.

