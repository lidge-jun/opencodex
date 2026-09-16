# Native plaintext tool identity correction

Prior D: wp2 source and static audit complete, hosted acceptance pending. Final consumer tracing found a missing identity component; split correction from final hosted verification rather than accepting helper-only mock expectations.

MODIFY `src/responses/plaintext-v2-agent-messages.ts`: private bare and qualified aliases in calls/selectors must restore both `namespace: "collaboration"` and the unqualified declared child name. Namespace-member declarations restore only their child name, without injecting a redundant namespace field. Foreign namespaces remain untouched. Add an explicit namespace-member traversal context so declarations and selectors are not conflated.

Before: an unqualified `start_delegated_task` becomes bare `spawn_agent`, or a qualified private name becomes `collaboration__spawn_agent`. After: a call becomes `{namespace:"collaboration",name:"spawn_agent"}`, preserving encrypted_function_args. A declaration inside restored namespace has `{type:"function",name:"spawn_agent"}`.

MODIFY `tests/responses/plaintext-v2-agent-messages.test.ts`, `tests/server/plaintext-v2-agent-messages-server.test.ts`, `tests/responses/ws-upstream.test.ts`: pin exact namespace+child identity for bare, dotted, double-underscore, JSON, SSE and WS restoration; assert a compatible namespace/name plus empty marker selects the documented native plaintext path. Keep foreign and opaque data negatives.

MODIFY `structure/subagents.md`: canonical dispatch identity is namespace plus unqualified child name. Source authority: locally inspected upstream `protocol/src/tool_name.rs` constructor preserves name literally; with_default_namespace assigns functions to absent namespace. `core/src/tools/router.rs` direct_source requires collaboration plus exact spawn_agent/send_message/followup_task and empty marker. This is source evidence, not a live backend canary.

No new settings or APIs; same request alias metadata and collision gates. Product checks remain hosted-only; local tests/build/typecheck/install NOT RUN. Independent design and A review precede code; final evidence remains wp4. This amendment adds work and does not remove any original acceptance requirement.
