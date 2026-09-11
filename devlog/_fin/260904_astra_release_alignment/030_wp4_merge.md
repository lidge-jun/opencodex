# 030 — wp4: land on dev

Consumes 010 and 020/021. Nothing here starts until both have closed with their own
evidence. Amended by 015/H5: the original gate was below repository policy.

## Preconditions

- 010's accept criteria met (catalog projection matches the pin, focused tests + typecheck
  green, live `/v1/models` shows the shipped window).
- wp3 has a recorded terminal outcome in `021_wp3_evidence.md` — a landed fix, or a
  NOOP/BLOCKED verdict with evidence. A NOOP still counts as closed; it just contributes
  documentation rather than a code diff.

## Pre-merge gate (015/H5)

AGENTS.md requires `bun run typecheck` AND `bun run test` before a non-trivial PR is
review-ready. This change reaches `metadata.ts`, `effort.ts`, and the sync path, which the
two focused test files do not cover, so "focused tests only" is not a defensible gate here.

The user's standing constraint for this session is that the full local suite is not run.
The substitute is named explicitly rather than left implicit:

1. `bun run typecheck` — exit 0, locally.
2. `bun test` on the focused files, plus `bun run test:changed` for the import-connected
   set — 0 fail, locally.
3. **Exact-head hosted CI**: after pushing, confirm the CI run whose head SHA equals the PR
   head is green before `gh pr merge --admin`. `gh pr checks` returning an empty required
   set is NOT green evidence — read the actual run conclusion for that SHA.

If exact-head CI cannot be confirmed green, the honest options are to wait or to record the
merge as admin-forced with the gap named in the PR description. Do not silently downgrade
the gate.

## Steps

1. Branch `codex/260904-astra-release-alignment` from current `dev`.
2. Commit in units: the upstream pin, the catalog/metadata realignment, the tests, and the
   devlog unit (DEV-GIT-COMMIT-01 — each logically complete step gets its own commit).
3. `git push --no-verify` — pre-authorized by the user for this session.
4. Open the PR with the repository template (Summary / Verification / Checklist), filled
   from real command output, not restated intent. No GUI change, so no screenshot gate.
5. Confirm the pre-merge gate above at the exact PR head SHA.
6. `gh pr merge --admin --merge` — pre-authorized. Merge commit, not squash, so the local
   `dev` can fast-forward onto it.
7. `git checkout dev && git pull --ff-only origin dev`.
8. Re-run `ocx service` and re-verify the live surface at the merged HEAD. Note that this
   restart drops in-flight turns (021) — expected, and the reason the user saw
   `adapter_eof` earlier.

## Accept criteria

1. PR number and merge commit sha recorded.
2. `git rev-parse --short HEAD` equals `git rev-parse --short origin/dev`, worktree clean.
3. `bun run typecheck` exit 0 at the merged HEAD.
4. Live at merged HEAD: `/healthz` ok, `/v1/models` contains `gpt-6-astra`, its
   `context_length` is 272,000, and its effort ladder still advertises `max` and `ultra`
   (the regression 015/C3 identified).
5. Exact-head CI conclusion recorded, or the gap named explicitly in the PR description.

### Verifier reality check (PLAN-VERIFIER-REAL-01)

- `git rev-parse` / `git status` — RUN repeatedly this session. Observes the target. YES.
- `curl /healthz` and `/v1/models` — RUN this session against port 10100. Observes the
  live projection, which is the thing the user actually sees. YES.
- `gh pr view --json state,mergeCommit` — RUN this session on #3410. YES.
