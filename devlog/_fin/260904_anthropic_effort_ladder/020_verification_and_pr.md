# 020 — Live verification and pull request

Work phase: wp3. Consumes 010.

## Why a live check is required

The unit tests prove the registry declares a ladder and the builder emits the
control. Neither proves the ladder survives the path a real user exercises:
config load, catalog assembly, the `/v1/models` serializer, then the export
writer into the file Aside parses. The reported bug lived precisely in that
seam — every individual component was correct.

## Steps

1. Rebuild/restart a SCRATCH proxy. The live proxy on port `10100` is the
   user's working instance and must not be disturbed for an experiment: use a
   separate `OPENCODEX_HOME` and a scratch port.
2. `curl -s http://127.0.0.1:<scratch>/v1/models` and confirm the
   `anthropic/claude-*` rows now carry `supports_reasoning_effort: true` and
   the five-rung ladder. Capture the before/after rows as evidence.
3. Render the Aside export document from the same catalog and confirm
   `reasoning: true` plus `thinkingLevelMap` on those rows. Do NOT overwrite
   the user's real `~/.aside/u/0/models.json` as part of the fix; render to a
   scratch path. Rewriting it is the user's own re-export action.
4. Optional UI confirmation via the Aside surface, if the scratch catalog can be
   pointed at without touching the signed-in profile's live config. Skipped
   rather than forced: mutating the user's real Aside config to take a
   screenshot would change account state for evidence, which is not a trade
   worth making when the file-level proof is exact.

## Commit and push

The worktree is DETACHED at `072df52e` and the local `dev` ref is behind it, so
"branch off dev" is ambiguous here and could produce a stale base. Bind the base
to a freshly fetched SHA instead:

1. `git fetch origin dev` and record `FETCH_HEAD`.
2. Confirm the current detached HEAD against it; branch from the fetched SHA.
3. `git switch -c codex/260904-anthropic-effort-ladder <sha>` — created IN this
   worktree (WORKTREE-GUARD-01: adopt in place, never relocate or recreate).
4. Preserve the untracked plan directory across the switch.

- Commit the three production files, the tests, and this devlog unit.
- 030 does NOT ship in this PR (see below).
- Push with `--no-verify` — explicitly authorized by the user for this task.
- The repository-wide suite is explicitly forbidden by the user, so the PR
  description states exactly which focused checks were run rather than implying
  the full gate passed. Claiming a green full suite that was never run is worse
  than reporting a narrower proof.

## One logical change

`030_related_empty_ladders.md` is an investigation of unrelated providers. It
stays in the plan unit as a record but its FINDINGS ship separately: a reviewer
judging an Anthropic ladder should not also have to adjudicate lidge and
opencode-free capabilities. If 030 produces a code change, it gets its own PR.

## Pull request

Target `dev` (never `main`). Fill all three template sections from
`.github/PULL_REQUEST_TEMPLATE.md`: Summary, Verification, Checklist. No
screenshot is required because the change touches no GUI surface; the title and
description must therefore avoid the word `gui`, which would trip the
screenshot gate in `enforce-target`.

## Accept criteria

- Live catalog shows the ladder for `anthropic/claude-*`.
- Export document shows `reasoning: true` and `thinkingLevelMap`.
- PR is open against `dev` with every template section filled, based on the
  exact fetched `origin/dev` SHA.
