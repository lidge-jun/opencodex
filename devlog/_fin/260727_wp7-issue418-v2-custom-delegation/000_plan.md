# 000 — WP7 Issue #418 V2 custom delegation investigation plan

## Objective

Handle Issue #418 only:

https://github.com/lidge-jun/opencodex/issues/418

The reporter reproduced custom-parent → custom-child V2 delegation failure on
OpenCodex `2.7.39` / Codex CLI `0.145.0`. They later supplied a control trace
showing ordinary structured tool-call arguments are preserved, but they still do
not have a same-run raw `spawn_agent` capture for the failing custom-parent
delegation call.

## Loop-spec

- Loop archetype: spec-satisfaction investigation/comment.
- Trigger: bug issue with partial reporter evidence but no same-run failing
  boundary trace.
- Goal: either identify a local OpenCodex fix or leave the issue with exact
  code-grounded trace requirements and current workaround.
- Non-goals: do not close #418; do not merge it into #92; do not add speculative
  instrumentation without a confirmed local defect.
- Verifier: live issue state, existing comment URLs, code pointers, and prior
  devlog analysis.
- Stop condition: Issue #418 already has an equivalent maintainer request naming
  what is known, what is not proven, and the exact trace needed to classify the
  failure; otherwise post one fresh maintainer comment.
- Terminal outcomes:
  - `DONE`: investigation state verified; either a fresh comment was posted or an
    equivalent existing maintainer request was confirmed.
  - `NOOP`: issue already contains an equivalent current maintainer request.
  - `BLOCKED`: GitHub comment mutation fails.
  - `NEEDS_HUMAN`: if deciding to instrument privacy-sensitive full request
    captures is required.

## Current evidence

Live issue #418:

- State: `OPEN`
- Label: `bug`
- Reporter has a 2.7.39 custom-parent → custom-child failure with repeated
  `missing field message` and no child lifecycle notification.
- Reporter also has a 2.7.39 ordinary structured tool-call control where
  arguments are preserved through provider raw response and Responses events.
- Reporter could not capture the failing `spawn_agent` raw call after
  instrumentation because the attempt hit a client usage limit.
- Existing maintainer request:
  https://github.com/lidge-jun/opencodex/issues/418#issuecomment-5069836945
  requests the same same-run provider/event/lifecycle boundary trace and keeps
  the issue open.
- Reporter acknowledged the limitation and committed to repeating after the
  usage limit clears:
  https://github.com/lidge-jun/opencodex/issues/418#issuecomment-5070272410.
- Collaborator cross-link keeps #418 separate from #92 and confirms it remains
  pending the three-boundary `spawn_agent` capture:
  https://github.com/lidge-jun/opencodex/issues/418#issuecomment-5085535548.

Current code pointers:

- V2 surface detection and guidance:
  `src/server/responses/collaboration.ts:136-154`,
  `src/server/responses/collaboration.ts:189-250`.
- Unreadable encrypted child-task guard:
  `src/server/responses/core.ts:447-459`,
  `src/server/responses/core.ts:870-890`,
  `src/server/responses/encrypted-payload.ts:185-231`,
  `src/server/responses/encrypted-payload.ts:265-306`.
- Agent-message parsing:
  `src/responses/parser.ts:338-360`.
- Prior analysis:
  `devlog/_fin/260723_issue_triage/007_investigation_290_288_spawn_agent.md:283-356`,
  `devlog/_fin/260723_issue_triage/007_investigation_290_288_spawn_agent.md:430-453`.

## Classification

`comment/request-changes` / `needs-info`.

OpenCodex has known handling for unreadable encrypted V2 child tasks (#92) and
for plaintext agent-message compatibility. The current #418 report still lacks
the one failing `spawn_agent` boundary trace needed to distinguish:

- inbound Codex/Desktop `additional_tools` schema already empty;
- OpenCodex adapter damaging the outgoing `spawn_agent` schema;
- provider/model emitting empty `{}` arguments for `spawn_agent`;
- OpenCodex bridge losing non-empty provider arguments;
- Codex V2 lifecycle failure after a valid spawn.

## Planned action

No new GitHub comment.

The A-gate review found that the prior owner and collaborator comments already
satisfy this phase's intended external action. Posting another maintainer comment
would be redundant and would add noise without new evidence.

Record a NOOP triage result that:

1. Confirms #418 remains separate from #92.
2. Confirms the issue is still `comment/request-changes` / `needs-info`.
3. Records the existing comment URLs that already request the same-run trace.
4. Records current code pointers showing no proven local path that erases a
   non-empty `spawn_agent` `message` argument.

No code change in this work-phase.
