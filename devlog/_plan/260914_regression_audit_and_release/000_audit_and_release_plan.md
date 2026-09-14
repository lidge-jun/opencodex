# 260914 — Regression audit and release

## Why this unit exists

`dev` is 43 commits ahead of both `main` and `preview`. Most of that arrived
today, across two delivery rounds plus a separate cost-guard session, and the
lanes were deliberately run in parallel. Each pull request was reviewed and each
reached green hosted CI at its own head. That is not the same as the merged tree
being right, because a lane only ever saw `dev` as it stood when the lane
branched.

So the question this unit answers is narrow and specific: **did any two merges
that touched the same file disagree with each other once both were on `dev`?**
Only after that is answered does the tree get promoted.

## The actual regression surface

Six source files were touched by three separate merges in this delta, and twelve
more by two. Those, not the diff size, are where a cross-merge regression can
live.

| File | Merges that touched it |
|---|---|
| `src/codex/routing.ts` | the cache-safe quota rebind, the cache-affinity default, the transient-hold fix |
| `src/server/responses/core.ts` | the control-strip scoping, the forward-identity sanitation, the terminal-refusal and reasoning-blob work |
| `src/web-search/passthrough-bridge.ts` | the destination assessment, the backend model binding, the mixed-tool leg |
| `src/chat/inbound.ts` | inbound image normalization, tool-result image carry, lossy-conversion refusal |
| `src/server/chat-native.ts` | same three chat-path merges |
| `src/server/chat-completions.ts` | same three chat-path merges |

Two-merge files worth naming because they cross lane boundaries:
`src/config.ts` and `src/types/config.ts` (the version-line bump and the
auto-refresh schema), `src/providers/registry.ts`, `src/adapters/anthropic.ts`,
`src/cli/connect.ts` and `src/cli/dispatch.ts`.

The routing file is the one to worry about most. Three separate sessions changed
account-binding behavior there in sequence, and one of them made cache affinity
the default, which changes the branch the other two are reached through. That is
exactly the shape of a regression that every individual CI run can be green for.

## How the audit runs

Reviewer subagents, one per contended file group, each reading the merged state
on `dev` rather than any single pull request's diff. The question put to each is
whether the merged result is coherent, not whether each change was correct on its
own. A finding is either fixed before promotion or written down here.

Alongside that, hosted Cross-platform CI must be green at the exact `dev` tip
SHA that gets promoted — not at a lane head, and not at an earlier tip.

## Promotion and release path

Promotion is a pull request from a release branch into `preview` and then into
`main`, matching how 2.54.0 was promoted. Both branches carry rulesets requiring
a pull request, so no direct push is attempted at any point.

`dev` already carries the 2.55.0 version line, opened ahead of the 2.54.0
release, so the stable release is 2.55.0 and the preview is the matching
preview stamp.

The npm release itself is dispatched through the Release workflow with an
explicit `expected-sha`, so a branch that moves between verification and
dispatch fails the publish instead of shipping an unaudited commit.

### One deliberate deviation, stated plainly

`scripts/release.ts` is the release authority, and its step 1 preflight runs a
dependency audit, a typecheck, the full test suite and a privacy scan locally
before it will bump anything. This unit does not run that preflight, because the
standing rule for this work is that no local suite runs and hosted exact-head CI
is the proof of record.

That substitution is defensible for three of the four checks and worth being
precise about. The CI `gates` job runs the typecheck, the privacy scan, the
generated-surface check, GUI lint, GUI tests and the GUI build; the test shards
run the same suite in the same grouping the preflight deliberately copied from
CI. The one check with no CI equivalent is `audit:high`, the dependency audit.
That one is run directly, since it is a dependency scan rather than a suite.

Everything the preflight does after step 1 — bump, commit, push, wait for CI,
dispatch with `expected-sha`, watch the run — is performed the same way the
script performs it.

## Acceptance criteria

1. Every file touched by more than one merge in the delta is reviewed for
   cross-merge interaction, with each finding fixed before promotion or recorded.
2. The exact `dev` tip SHA being promoted has green hosted Cross-platform CI.
3. `preview` carries the promoted tree and a preview npm release is published,
   with the workflow run and resulting dist-tag recorded.
4. `main` carries the promoted tree and the stable npm release is published,
   with the workflow run, dist-tag and git tag recorded.

## What would make this fail

Promoting on the strength of thirteen green lane runs. Every one of those was
green against a different `dev`. The only CI result that says anything about
what users will install is the one at the tip being promoted.
