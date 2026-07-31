# 000 — release-v2729: Plan
# Release v2.7.29 Plan

## Objective
Merge dev into main and publish v2.7.29 to npm.

## Changes since v2.7.28 (13 commits)
Key changes:
- `9b412d8e` fix: preserve configured Alibaba Token Plan base URL (allowBaseUrlOverride: true)
- `def60bce` fix(alibaba): preserve reasoning_content for qwen3.8-max-preview
- `2ea15d85` feat(providers): add Cloudflare Workers AI provider (#191)
- `477f6dd1` fix: restore GUI request logs after ocx stop/start (#195)
- `e84e3aa2` fix(update): hard-pin listen port after update (#193)
- Plus: ocx account CLI docs, redaction fixes, provider-quotas routing (#180)

## Constraints
- No breaking changes, no config schema changes
- release.ts enforces: must be on main, clean tree, tsc passes, tests pass, privacy scan passes

## Phase Map (single phase)
- 010: merge + release

## Accept Criteria
- c1: merge without conflicts
- c2: build (tsc) exit 0
- c3: test suite exit 0
- c4: npm view @bitkyc08/opencodex dist-tags latest = 2.7.29
> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

(fill in: the concrete outcome, the observed failure, the evidence base)

## Loop-spec

- Loop archetype: (verifier-defined | judged)
- Write scope / out-of-scope:
- Budget / bounds:

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|

## Accept criteria

- (mirror into the goalplan criteria[])
