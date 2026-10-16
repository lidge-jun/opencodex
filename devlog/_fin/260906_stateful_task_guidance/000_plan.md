# Stateful external-task guidance consistency

Parent PR #3743 recognizes a complete external task-input envelope as a user turn
and starts the parsed continuation boundary there. Its review identified the
remaining raw insertion predicate in collaboration.ts, which still recognizes
only ordinary user/assistant messages and agent_message. In a stateful delta,
generated guidance can therefore precede the task in parsed messages but follow
it in the stored raw input; reparsing changes the delivered order.

This C4 protocol/replay follow-up is a separate PABCD work-phase before Kiro
implementation resumes. The Kiro phase remains open with no code changes; the
goalplan gained an additional criterion and an explicit focus cursor, without
marking any unfinished task complete or weakening existing criteria.

Archetype: spec-satisfaction repair. Goal: the same conversational boundary in
parsed and raw stateful representations. Non-goals: new envelope forms, broader
tool-output repair, stateless insertion changes, auth changes or live Kiro.
Verifier: hosted ci.yml runtime/type/privacy gates and focused regression cases
in tests/codex-integration/multi-agent-compat.test.ts. No local test suite,
typecheck or build. Stop only after exact-head CI and independent review pass,
parent review is resolved and its verified head is ready for the Kiro cascade.

Resources inherit the authorized release loop: existing repository/GitHub access,
requested xai/grok-4.6 reviewers, no new credentials or purchases, no fixed model
cost cap, bounded processes and status waits. Main owns code/FSM/GitHub actions;
reviewers are read-only. Reclaim failed dispatches; no implicit phase movement.
Design and final source/CI evidence reside in this unit and the bound goalplan.

The complete implementation map is 010_raw_boundary.md. Apply the verified delta
to parent #3743, then refresh the saved Kiro branch from that parent before B.
