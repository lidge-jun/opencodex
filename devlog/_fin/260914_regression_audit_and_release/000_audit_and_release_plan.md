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
branch and clean-tree guard, version-availability and channel-forward checks, a
dependency audit, a typecheck, the full test suite and a privacy scan locally
before it will bump anything. This unit does not run that preflight, because the
standing rule for this work is that no local suite runs and hosted exact-head CI
is the proof of record.

An audit of this plan corrected three things about that substitution, and the
corrections matter more than the original claim did.

The typecheck and privacy scan really are covered: the CI `gates` job runs
`bun x tsc --noEmit` and `bun run privacy:scan` directly. But the suite is
**not** run in the same grouping. The preflight copies CI's isolation policy, not
its shard layout: CI runs four Linux shards through
`scripts/ci/run-bun-test-batches.sh` with the worker-heavy files pulled into
dedicated jobs, plus two macOS shards and an unsharded macOS control job, while
the preflight runs one `bun test --isolate tests` with path-ignores and then
seven isolated files one at a time. Same files, different partitioning. CI is the
broader of the two, since it adds the macOS matrix the preflight never runs.

`audit:high` is not uncovered either — `release.yml` runs it as a publish step,
and so are the branch match and the unused-version, unused-tag and
unused-GitHub-release checks, which run in `validate-dispatch` and
`Preflight release metadata`. Only two things are genuinely script-only: the
clean-working-tree guard, and `assertChannelVersionMovesForward`, which reads
the live npm dist-tags and refuses a channel that would move backwards. Both are
checked by hand before each dispatch.

Everything the script does after step 1 is performed the same way, with one real
difference: the script bumps, commits and **pushes directly** to `main` or
`preview` using a release deploy key. This unit does not push to a protected
branch at all. The version line moves inside the promotion pull request, and the
merge commit becomes the release SHA.

### The version-line ordering, which the audit caught twice

The first draft said `dev` already carries 2.55.0 so 2.55.0 is what ships. That
is backwards, and `release.yml` would have refused the publish. Its **Require
dev to be ready for this release** step runs `version-line.ts assert-ahead`
against `origin/dev:package.json`, and equal versions fail. `dev` is opened at
the NEXT version before a release, not at the version being released — exactly
what commit `866367a6ff` in this very delta did when it opened `dev` at 2.55.0
ahead of shipping 2.54.0.

The second draft still said one product tree goes to both branches. It cannot.
`release.yml` requires `package.json` to **equal** the dispatched version, and a
`preview` dispatch must carry a prerelease version. So `preview` and `main`
carry two different version lines over the same product tree, which is what
2.54.0 did: `main` at `2.54.0`, `preview` at `2.54.0-preview.20260914`.

The order, then:

1. Promote the audited `dev` tree to `preview` through a pull request whose
   branch **rewrites `package.json` to `2.55.0-preview.<stamp>`**.
2. Publish that preview from `preview`. No dev move is needed first, because a
   stable 2.55.0 on `dev` already outranks the prerelease.
3. Promote the same audited tree to `main` through a pull request that leaves
   `package.json` at `2.55.0`.
4. Move `dev` to 2.56.0 by dispatching `dev-version-bump` with
   `intended-version=2.55.0` — the input is the version about to be released,
   and the workflow opens a pull request rather than pushing — then merge it.
5. Only then publish stable `2.55.0` from `main`.

Dispatch inputs for both publishes are `version`, `tag`, `expected-sha` and
`dry-run`. `expected-sha` must be the full 40-character SHA and must equal the
branch head at dispatch time, which is what makes a branch that moved fail the
publish instead of shipping something unaudited. Each publish is dispatched once
as a dry run and then re-dispatched with `dry-run=false`.

Two prerequisites at the release SHA, both easy to get wrong:

- `release.yml` accepts only a successful **push-event** `ci.yml` run on
  `main`/`preview` for that commit. A green pull-request run at the same SHA is
  refused, so the run that counts is the one the merge itself triggers.
- Service lifecycle must also be green there, because `package.json` is a
  service-lifecycle trigger path.

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
