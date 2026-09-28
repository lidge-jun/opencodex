# Design comparison and proposed native contract

This is an RFC, not an accepted architecture change or a released setting.
`probes/native_policy.py` is an executable specification, **not native Rust code**.
No probe is imported by OpenCodex or registered in its runtime/CLI/test suite.

## Evidence and scope

The source baseline is OpenAI Codex
`1cc7e2361237ce7244430ee1d581c77f95c57ac8` and OpenCodex `dev`
`eb7f0f0970c2298f8b2d66d170c4d4be869f301b`.

- [Native list predicate](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server/src/request_processors/thread_processor.rs#L5456-L5530): explicit nonempty arrays filter to those ids; `[]` removes the provider predicate; omission defaults to the configured provider, except for related-thread queries.
- [Remote connection origin](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server-transport/src/transport/remote_control/client_tracker.rs): native remote sessions open with `ConnectionOrigin::RemoteControl`; messages become native transport events.
- [Original rationale, #5658](https://github.com/openai/codex/pull/5658): provider annotations/filtering address cross-provider resume/decryption failures. Visibility is not proof that a conversation is safe to resume under a different provider.
- [OpenCodex mitigation, #6007](https://github.com/lidge-jun/opencodex/pull/6007): warnings and documentation without rewriting native history or intercepting native RPC.

## Alternatives

| Approach | Can leave official mobile app unchanged? | Additional ownership | Recommendation |
| --- | --- | --- | --- |
| Mobile explicitly sends `modelProviders: []` (or a chosen list) | No | Client's list behavior and resume UX | Simplest client correction; continue upstream tracking. |
| Native, opt-in, remote-only default list policy | Yes, once a compatible native build ships | Native config and request policy, no extra service | **Preferred implementation proposal** when the host needs explicit control. |
| Local relay selected through `chatgpt_base_url` | Potentially; live service not verified | Shared backend traffic, token forwarding, connection lifecycle | Research fallback, not a default or currently supported remedy. |
| Globally change omitted filter to all providers | Yes | Changes behavior for every caller | Do not use: loses the existing default isolation behavior. |
| Rewrite `openai` history tags to `opencodex` | Yes in some observations | Native SQLite/rollout state | Do not use: violates the retained history-writer boundary. |

The native proposal minimizes new connection and credential handling; this is an
engineering recommendation, not evidence of upstream acceptance or deployment.
Neither upstream route can be delivered by modifying OpenCodex's `/v1` inference
proxy alone. This PR publishes the comparison rather than disguising a probe as a fix.

## Proposed native setting (name subject to upstream review)

**Illustrative only; do not add this to current Codex/OpenCodex configuration.**

```toml
[remote_control]
thread_list_model_providers = ["openai", "opencodex"]
```

Absent setting means opt-out. An explicitly empty array means all providers;
a nonempty array means exactly those ids. Do not automatically infer equivalence
from provider names, model names, or a shared URL. The setting changes listing,
not authentication, permission checks, routing, compaction, or resume semantics.
An operator who only needs two provider ids need not opt into every provider.

### Precedence

1. Existing authentication and managed remote-control policy still run first.
2. A request's explicit provider **array**, including `[]`, always wins.
3. With no array, parent/ancestor queries retain their current no-default-filter behavior.
4. Only a server-identified remote connection may use the operator's configured policy.
5. With no policy, and for every non-remote connection, preserve the existing default.

Typed Rust `Option<Vec<String>>` treats omission and JSON `null` alike. This
proposal deliberately applies its default to both. The raw relay probe preserves
all present JSON keys, including null; that difference is documented and must not
be mistaken for identical behavior between the two alternatives.

Use the native `ConnectionOrigin` attached to the connection. Never infer remote
origin from clientInfo.name, a user-agent, JSON fields, or a caller-supplied header.
The Python enum tests only model this trusted input; they do not prove authentication.

### Native implementation boundary

The upstream change must add and validate the config contract, snapshot it with
the native app-server's effective configuration, carry the trusted connection
origin to the `thread/list` handler, and resolve the provider predicate before
calling the existing store pagination. A new RPC layer is unnecessary.

Conceptual selection, **not a drop-in patch**:

```text
if request supplies provider array: use that array
else if parent/ancestor query: use existing related-thread behavior
else if trusted origin is RemoteControl and operator policy is configured:
    use the configured array
else: use existing configured-default behavior
```

Do not add a global exception to `list_threads_common` for all callers. Do not
change `thread/start`, `thread/resume`, `turn/start`, stored provider metadata,
or request error handling. Keep source/cwd/archive/project filters and ordering.
The new configuration's trust/precedence should prevent project content from
silently opting an operator into a broader default; upstream must choose and test
the appropriate configuration layers and any managed restrictions.

Hold one effective policy throughout a listing/pagination sequence. A changed
policy requires a fresh listing cursor; do not combine pages obtained under
incompatible filters. Native tests must pin behavior with actual cursor semantics.
The fixture tests here use integer pagination, not native opaque cursors.

## Local relay alternative: what was and was not shown

[Native startup](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server/src/lib.rs)
uses `config.chatgpt_base_url` for remote control. The
[URL protocol](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server-transport/src/transport/remote_control/protocol.rs)
accepts loopback URLs. A host-side relay is therefore a concrete design alternative:

```text
unchanged mobile <-> existing ChatGPT backend <-> local relay <-> native app-server
```

Connection establishment starts on the host. Enroll/pair/refresh can be forwarded
rather than reimplemented. However, `chatgpt_base_url` is shared with
[authentication configuration](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/core/src/config/auth_keyring.rs)
and other backend consumers. A WebSocket-only implementation is insufficient.
[Enrollment persistence](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server-transport/src/transport/remote_control/enroll.rs)
also keys state by URL/account/client, so changing the URL can affect enrollment
selection; whether live re-pairing is required remains unverified.

The retained relay fixture accepts only literal `127.0.0.1` HTTP upstreams and
synthetic credentials. It is not a production service and cannot be configured
for ChatGPT. It handles regular and single-chunk frames; multi-chunk messages are
passed unchanged. Actual protocol-v3 segmentation, native reconnect/ACK/cursors,
account changes, managed network policy, and full backend compatibility remain
release gates, not claims supported by these tests. See native
[WebSocket handling](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs).

No global base-URL mutation, token-pool integration, production listener,
configuration migration, history write, or authentication bypass is proposed here.

## Upstream and downstream follow-through

An upstream implementation needs Rust config/schema, origin-scoping, explicit/null/
related-query, pagination, and managed-policy tests. Keep existing defaults intact.
Document the omitted/default behavior and regenerate affected schema/TS fixtures.

After an accepted implementation is released, OpenCodex may consider an opt-in
integration with positive capability/version evidence and precise configuration
ownership/restoration. Merely writing an unknown TOML key is not a feature test.
Until then, retain #6007's warnings and keep #5848 open. Do not suppress the warning
because an experimental setting was written or a fixture passed.
