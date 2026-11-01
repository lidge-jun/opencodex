# Codex installation identity

`src/codex/installation-id.ts` derives a stable UUIDv4-layout identity from the canonical
ChatGPT account ID using HMAC-SHA256 with a private, persistent 32-byte
`codex-installation-secret` under the OpenCodex config home and the domain
`opencodex-codex-installation-id-v1`. The UUID version and variant bits follow RFC 9562 §5.4;
the remaining bits are deterministic HMAC output. Tokens, slot aliases and caller installation IDs
are not inputs. Atomic no-replace publication selects one complete secret across processes;
corrupt or unreadable secrets are refused rather than replaced. POSIX mode is 0600; Windows uses
the shared required secret ACL hardener on the parent and empty temporary file before writing any
key bytes. Each secret file's required hardening protects its DACL from inheritance before bytes
are written or read; optional parent or sibling ACL work does not refuse derivation. Real
secret-file or creation-directory hardening failures still fail closed.
`src/server/responses/passthrough-build-error.ts` preserves this refusal even after auth preparation.
Required operations return a sanitized retryable 503 on identity failure; optional helpers disable
themselves without aborting an independent routed request.

`src/codex/auth-context.ts` and `src/codex/auth-context-provider.ts` carry the selected Pool identity
in the runtime provider override. Only `kind: pool` rewrites existing installation headers and
client-metadata fields; `main` and `main-pool` preserve caller values. Absent surfaces remain absent
and do not read identity storage. Provider overrides carry account credentials; derivation occurs
only when a wire installation surface exists. Empty credential/routing headers remain omitted,
while empty installation and turn-metadata headers retain their existence gates.
`src/codex/forward-transport-headers.ts` also isolates a present installation field inside native
turn metadata and strips caller attestations from substituted credentials. Its selected-header merge
prevents removed identity fields from reappearing through provider defaults.

`src/adapters/openai-responses/transport.ts` and `src/adapters/openai-responses/passthrough.ts`
apply the same identity to HTTP headers and a cloned client-metadata map. The serialized body feeds
`src/server/responses/codex-ws-request.ts`; WebSocket preparation preserves these existence gates.
`src/server/responses/codex-ws-pool.ts` includes immutable outgoing headers and account in its reuse
identity. `src/server/ws-bridge.ts` isolates explicit Pool header overrides as well.
Native compact in `src/server/responses/compact.ts` projects the body per physical send, so a quota
failover uses the newly selected account ID. Alternate construction reports identity failures as
503 instead of treating them as absence of an eligible account, while recording the first
account's completed rejection and quota headers without attributing a send to the alternate.
`src/server/context-history.ts` applies the same clone
and header contract. `src/server/search.ts`, `src/server/images.ts` and `src/server/live.ts`
retain the selected context and project cloned client metadata immediately before each physical
JSON send, including live's converted multipart session. Their selected headers authoritatively
replace or remove mixed-case provider identity defaults; main and main-pool preserve caller values.
Vision, audio and sidecar credential selection share materialization.
The optional availability probe in `src/server/claude-messages.ts` treats an installation-identity
failure as helper unavailability, allowing an independent native Messages route to continue.
`src/codex/affinity-debug.ts` reports only process-local keyed equality tags, never raw identities.
The regression contracts are in `tests/codex-integration/codex-installation-id.test.ts`,
`tests/codex-integration/codex-installation-wire.test.ts`,
`tests/codex-integration/codex-installation-acl.test.ts` and
`tests/responses/codex-installation-failover.test.ts`; auxiliary wire coverage is in
`tests/codex-integration/codex-installation-sidecars.test.ts`. Native Messages fallback is covered by
`tests/claude-integration/claude-installation-helper.test.ts`.
