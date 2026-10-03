# wp7 — Revalidate observation and selected-key workflows

Parent is d7f73523cac15614765f2a042ac874f24dcbed92, published as #6542. Prior D closed fifteen integration/maintenance rows with functional, security and document reviews passing, 320 declared capabilities and a frozen-tree 67-invocation CLI QA receipt. Parent hosted CI is a separate publication obligation. The next direction remains the prewritten 070 observation/API-tools phase.

## Loop contract

This satisfy-spec cycle completes the remaining named GUI-equivalent observation and API-tool tasks. Log cursor/state fidelity is C3; explicit-key model/audio consumers receive separate C4 scrutiny. It does not change server admission, provider behavior, GUI design or consent boundaries. No live user key, microphone, provider request, installed runtime, service or remote execution is a development QA target. No time/token limit was specified.

The phase stops after its assigned rows, operating guidance, direct/indirect regressions, actual CLI fixture QA and independent functional/security review are complete. Exact-head hosted CI remains required for the published layer. Unexpected admission or protocol behavior returns to main for a source-grounded decision, never a management-header fallback or weaker claim. Numbered plan/evidence lives in this unit; sensitive investigation notes stay in scratch.

## Main source revalidation

`src/cli/access.ts:255` owns the existing unkeyed protocol payloads: chat/messages have max_tokens16 and responses max_output_tokens16. Existing unkeyed commands use the legacy transport; explicit-key commands must select their own data-plane path before that wrapper. They cannot reuse management-header construction or claim the unkeyed result proves a chosen key.

`src/client/state.ts:85` distinguishes disconnected, connected, invalid and mismatched enrollment. `assertClientConnectionUnchanged` at line138 compares the full stored connection snapshot and refuses pending disconnect. `src/client/hub-client.ts:171` normalizes an HTTP(S) origin, permits only root or /v1 path forms, rejects userinfo/query/fragment and enforces HTTPS-or-loopback. These are existing owners for enrollment/transport validation. Reading the enrollment snapshot does not authorize substituting its stored data key.

Current serve dispatch uses `resolveResponsesApiAuth` for both Responses and Chat (`src/server/index/serve-options.ts:1449`, `:1565`) and `resolveApiAuth` for Messages (`:1533`). `src/server/auth-cors.ts:574` and `:601` admit an authless loopback listener before reading a token. The explicit credentialless malformed-body control in070 therefore remains essential to its limited observation; a matching native401 still cannot certify the next request's policy or billing identity. Real fixtures must use the actual protocol-specific resolver, not interchangeable hand-written 401s.

`src/lib/bounded-body.ts` provides cancellable byte-bounded response consumption. A total request deadline must begin before fetch and remain active through body consumption, rather than being restarted at response headers. Model-output/error projection must never serialize the supplied secret, a fingerprint or arbitrary transport exception text. The executable refinement resolves response fields and all ownership/cleanup paths before B.

Observation and audio investigators own their separate current route/DTO/stream source packets. Architect consultation then defines exact shared interfaces and disjoint implementation scopes in070 before independent A review.

## Executed baseline and runtime probe

`bun test tests/server/data-plane-admission-identity.test.ts tests/claude-integration/messages-surface-matrix.test.ts` passed 47 tests and 173 assertions, exit0. These explicit file arguments observe current resolver identity/precedence and Messages parser/enablement composition, not the future chosen-key CLI. Log: `.tmp/cli-parity/wp7-admission-baseline.log`.

The installed Bun1.4.0 WebSocket client was exercised against two owned loopback endpoints for each of HTTP301/302/303/307/308, with both HTTP and WS Location forms. All ten handshakes closed with code1002 and zero requests at the redirect destination. All twenty listeners stopped and sockets terminated. This is current native-client transport evidence, not an HTTP fetch-option inference; persistent regressions must retain the same check. Scratch probe and log: `.tmp/cli-parity/wp7-ws-redirect-probe.ts` and `.log`. No installed service, real key or upstream was contacted.
