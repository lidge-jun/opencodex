# 000 — a_stack_responses_compat: Plan

## Objective

Land four Responses-compatibility changes on `dev` as one manual dependent branch
chain whose tip carries all of them, so a single CI run certifies the whole set.
Three layers carry existing contributor pull requests; one is new work for an
issue that has no pull request.

| Layer | Source | Author to preserve | Subject |
|---|---|---|---|
| 1 | PR #3906, commit `11c498b6c` | MohamadSabree8 | Muse Spark Contributor Free tiers keep unsupported `web_search` fields |
| 2 | PR #3886, commit `83c1d9b12` | cb8010d6 | Spark streams end `adapter_eof` when the Responses Lite header is present |
| 3 | Issue #3922, new work | — | Claude optional tool parameters become strict on Responses routes |
| 4 | PR #3917, commit `2430724e5` | mashfromband | Routed destinations reject Codex `agent_message` with 422 |

Evidence base: four read-only `gpt-6-astra` explorer lanes read the current tree at
`2abf071e0` and returned quoted `path:line` anchors, reproduced in each phase doc.

## Loop-spec

- Loop archetype: satisfy-spec. Each layer has a stated correct behavior; there is
  no metric to optimize.
- Trigger: maintainer request to execute workstream A as a stack.
- Goal: the tip merged into `dev`, children settled with authors preserved, linked
  issues closed.
- Non-goals: registry `modelWireDefaults` for the `-free` ids; setting the Lite
  header to `"false"` instead of removing it; PR #3838's tool-promotion,
  `customToolWireName` export and `statelessResponses` work; any other open PR;
  `main`/`preview` promotion.
- Verifier: the single Cross-platform CI run on the tip pull request's head SHA.
  It runs the repository's own workflow over the cumulative tree, so it observes
  every file changed by all four layers.
- Write scope: `src/adapters/openai-responses.ts`, `src/adapters/opencode-go.ts` ->
  `src/adapters/routed-agent-messages.ts`, `src/claude/inbound-content-options.ts`,
  their regressions, the two test-layout registries,
  `docs-site/src/content/docs/reference/adapters.md`,
  `docs-site/src/content/docs/reference/configuration/providers.md`, and this unit.
- Budget: no local suite runs at all (instructed). Wall-clock bound is the CI run
  plus merge; a red tip after one bounded repair attempt is BLOCKED, not DONE.
- Stop condition: the stack landed on `dev`, proven for the merge method actually
  used (see 050): original-tip ancestry for a merge commit, or landed-commit
  ancestry plus per-path content equality for squash and rebase.
- Memory artifact: this unit, plus the goalplan at
  `.codexclaw/goalplans/deliver-opencodex-workstream-a-responses-compati/`.
- Escalation: a finding that changes a carried author's intended behavior, or a
  provider that rejects an explicit `strict: false`, returns to the maintainer.

## Constraints (from the requesting maintainer)

- No local product suite, typecheck, build or install runs in this session. Every
  such check is recorded `NOT RUN`.
- Every push uses `--no-verify`.
- CI triggers on the stack tip only. When that one run is green, the tip merges
  into `dev`; the remaining pull requests are then settled and the issues closed.
- Carried work keeps its original author through a `Co-authored-by` trailer.

## Why tip-only CI is achievable

`.github/workflows/ci.yml` declares `pull_request: {}` with no base filter, and
`push: branches: [main, preview, dev]`. Pushing `codex/a-stack-l1..l3` starts no
workflow: those refs are not integration branches and no pull request points at
them. Opening exactly one pull request, for layer 4 against `dev`, produces
exactly one Cross-platform CI run whose head contains all four layers.

## Base and chain

Base: `origin/dev` = `942c028735d39b2ad410b1baa95670984e16576d`.

```
codex/a-stack-l4-routed-agentmsg   (tip, the only pull request) -> base dev
codex/a-stack-l3-claude-strict
codex/a-stack-l2-spark-lite
codex/a-stack-l1-muse-free
origin/dev 942c02873
```

An ordinary dependent branch chain. GitHub native stacks are not used and were
not requested.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp0 | 000 | This roadmap (docs only) | — |
| wp1 | 010 | Layer 1, carry #3906 | wp0 |
| wp2 | 020 | Layer 2, carry #3886 | wp1 |
| wp3 | 030 | Layer 3, implement #3922 | wp2 |
| wp4 | 040 | Layer 4, carry #3917 | wp3 |
| wp5 | 050 | Publish, one CI run, merge, settle | wp4 |

Ordering follows textual adjacency in `src/adapters/openai-responses.ts`, which
layers 1, 2 and 4 all touch at distinct hunks (≈2125, ≈2503, ≈2366 and its import).
Layer 3 touches `src/claude/inbound-content-options.ts` only.

## Terminal outcomes

- DONE — the stack landed on `dev` with the merge-method-specific proof recorded,
  children settled with authors preserved, issues #3885/#3922/#3911 closed.
- BLOCKED — CI red on the tip after a bounded repair attempt, or an unmet merge
  requirement.
- NEEDS_HUMAN — an audit finding that would change a carried author's intended
  behavior beyond what the issue asks.
