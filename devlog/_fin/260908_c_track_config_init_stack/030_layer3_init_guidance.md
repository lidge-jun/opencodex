# 030_layer3_init_guidance.md — wp3: carry PR #3896 (stack tip)

Source: [PR #3896](https://github.com/lidge-jun/opencodex/pull/3896) by
@parkjs101 (Joonsuh Park), head `fc78bc37d419576061b995281baf39c46655eaa9`,
closes [#3893](https://github.com/lidge-jun/opencodex/issues/3893).

Branch: `codex/c-track-init-guidance`, based on `codex/c-track-initialize-flag`.
This is the stack tip and the only pull request opened for this unit.

## Problem

`ocx init` already separates denied hard-link publication from a generic
failure, but a required permission-hardening failure falls into the generic
message, and neither message tells the user what to do next. The user cannot
tell why publication stopped or where to move `OPENCODEX_HOME`.

## Change (carried from #3896, rebased onto wp2)

- `src/config/initialize.ts`: a `hardeningFailed` flag set immediately before
  the hardening call and cleared immediately after it returns — the assignments
  surround `hardenInitialConfig`, which runs after `openSync`. The flag selects
  a distinct message; `InitialConfigPublicationError` takes the matching option,
  and both messages gain `OPENCODEX_HOME` recovery direction.
- `docs-site/src/content/docs/getting-started/quickstart.md`: inspection before
  retry, preserving existing configuration, choosing a supported location.
- `structure/02_config-and-codex-home.md`: records the diagnostic distinction.
- `tests/config/config-mutation-lock.test.ts`, `tests/service/init-eof.test.ts`:
  permission, link, and cleanup faults, privacy-safe messages, backup
  preservation. Both files already exist in the test-layout registries, so no
  registry entry is added.
- `devlog/_plan/260907_init_publication_guidance/010_implementation.md`: carried
  as-is; on terminal closure that unit moves to `_fin/`.

The rebase keeps wp2's `openSync(temp, "wx", 0o600)` and both `hardeningFailed`
assignments around the hardening call.

## Review (independent subagent audit, read-only, this session)

Reviewed at `fc78bc37d`, all six files. No blocking finding:

- The flag cannot be left incorrectly true. Write, verify, link, and close
  failures all occur after it is cleared (`src/config/initialize.ts:95-115`,
  `:129-134`). A throwing injected `io.harden` test seam would select the same
  message, which is a seam edge rather than a production defect.
- File I/O ordering, the no-replace guarantee, and private permissions are
  unchanged (`:38-43`, `:98-130`).
- The new messages are fixed text naming the `OPENCODEX_HOME` variable; they
  interpolate no real paths, bytes, or filesystem error text, and raw errors
  stay in the `cause` the CLI does not print (`src/cli/init.ts:262-267`).

This is a static agent review, not the maintainer security review or the
approval required by `MAINTAINERS.md`; those are recorded separately in `040`.

## Authorship

Carried with `Co-authored-by: Joonsuh Park <trckstr4422@gmail.com>`, the identity
on the source commit. The trailer must appear in the **squash message** of the
landed commit, and is verified on the landed commit rather than only on the
branch.

## Verification

This tip is the only layer that triggers repository CI, and its exact head SHA
must be green against a current `dev` base. Local suite, typecheck, and build:
**NOT RUN** (owner instruction).
