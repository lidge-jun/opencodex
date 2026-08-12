# 011 — Audit synthesis (round 1, verdict FAIL)

Reviewer returned `VERDICT: FAIL` with 7 blockers. Each was re-verified against the
worktree before disposition (REVIEW-SYNTHESIS-01). Four are accepted and folded in,
three are rebutted with recorded rationale.

## Accepted — folded into the plan

**B4 (accepted, and it is the sharpest finding). Custom-name save drops the note.**
Verified: `gui/src/provider-payload.ts:83-108` builds the POST body with no `note`
field, and `src/server/auth-cors.ts:507-510` resolves the note by *provider name*
through `providerMatchesRegistryTransport`. So a user who adds the preset under a
custom name gets a provider whose warning silently disappears. The mitigation must
not depend on the row keeping its registry name. Fold: persist the note into the
POST body so a renamed provider still carries it, and cover it with a test.

**B5 (accepted). Plan models lack text-only declarations.**
Verified: `VOLCENGINE_PLAN_INPUT_MODALITIES` (`registry.ts:373-376`) declares only
`kimi-k2.6` and `minimax-m3` as multimodal; the remaining Plan models declare
nothing, and Tencent's precedent (`registry.ts:1052-1053`) declares every model
text-only via `modelInputModalities` + `noVisionModels`. Fold: declare the
text-only Plan models explicitly on both Plan entries.

**B6 (accepted, and my plan was wrong to exclude docs).** Verified: the Tencent
restriction warning exists in the public docs at
`docs-site/src/content/docs/guides/providers.md:254-256`. A user-facing restriction
that ships in `note` but not in the docs is half-disclosed. Fold: add the
equivalent blockquote to the English provider guide.

**B1 (accepted as residual, not as a merge blocker).** The named maintenance owner
is genuinely absent. It is a PR-description field owned by the author, not a code
defect, and the merge comment will name it as an outstanding item with a request to
the author. Recorded honestly rather than silently waived — the earlier plan text
that called it non-blocking was too casual.

## Rebutted — with rationale

**B2 (rebutted). "Supported clients do not establish proxy authorization."**
This is the reviewer's strongest argument and it deserves a real answer rather than
a dismissal. Three reasons it does not block:

1. opencodex is not an aggregator in the sense `MAINTAINERS.md` guards against. The
   gate's "resale or routing authorization for aggregators" targets a service that
   resells pooled capacity to third parties. Here the user supplies their own Ark
   plan key, and it is used only to serve that same user's Codex CLI / Claude Code
   session. Nothing is resold and no credential is pooled.
2. Volcengine documents the exact clients opencodex exists to serve — Codex CLI has
   its own official integration page (`docs.volcengine.com/docs/82379/2556056`), and
   Claude Code, OpenCode, and OpenClaw appear in the supported-client list
   (`82379/2188957`). The traffic opencodex forwards is a supported client's traffic.
3. The restriction the reviewer cites is about *what the quota may be spent on*
   (coding tools, not general API automation), and that condition is satisfied by
   this use, not violated by it.

The residual risk is real and is precisely why B4/B5/B6 are being folded in: the
user must be told. Disclosure is the correct instrument; demoting to an inert
`free-directory.ts` row would also deny the documented, authorized use.

**B3 (partially rebutted, wording narrowed).** The reviewer is right that
`article/37156` is Coding Plan-specific and that I should not apply Coding-Plan
wording verbatim to Agent Plan. But both are subscription Plan routes under the
same Ark plan-quota model, and the Agent Plan announcement frames it around the
same supported tools. Disposition: keep a warning on Agent Plan but narrow its
wording so it does not assert a Coding-Plan-specific term as if it were quoted
Agent Plan policy.

**B7 (rebutted as stated, action taken anyway).** `origin/dev` moving ahead is not
a plan defect — it is ordinary drift on a busy branch, and GitHub reports the PR
`MERGEABLE`. A rebase is not required for correctness. However, re-running gates on
a head that includes current `dev` is cheap and strictly better evidence, so the
build phase will rebase and re-verify regardless.

## Corrections to my own plan

- `derive.ts:296` was a wrong citation; the note copy is at `derive.ts:302`.
- The tests use `toMatchObject`, not full-object `toEqual`, so no existing expected
  string needs editing — explicit note assertions are added instead.

## Amended change map (supersedes 010 §Change map)

1. `src/providers/registry.ts` — two `note` strings (Agent Plan wording narrowed).
2. `src/providers/registry.ts` — text-only declarations for both Plan entries.
3. `gui/src/provider-payload.ts` + its form/caller — carry `note` into the POST body.
4. `docs-site/src/content/docs/guides/providers.md` — restriction blockquote.
5. `tests/volcengine-providers.test.ts` — note assertions, text-only assertions.
6. `gui/tests/` — a payload test proving a renamed provider keeps its note.
