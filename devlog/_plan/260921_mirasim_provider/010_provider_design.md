# Mirasim provider native port

## Goal

Port the current `cpa-plugin-mirasim` protocol into OpenCodex as a native provider without embedding CLIProxyAPI or its native plugin ABI.

Reference implementation pinned for this port:

- `KIDA-MNESIA/cpa-plugin-mirasim` v1.1.0 / `857a984`
- OpenCodex base after the final pre-port fast-forward: `origin/dev` / `a49974639`

## Architecture

```text
Codex / Claude Code
        |
        v
OpenCodex router
        |
        v
Mirasim adapter
   |             |
   |             +-- GPT -> existing OpenAI Responses serializer/parser
   |
   +-- Claude -> existing Anthropic serializer/parser
        |
        v
Mirasim transport
   - OAuth access/refresh
   - Ed25519 device identity
   - device ticket mint/cache
   - mrs-sig-v2 request signing
   - mrs-seal-v1 inference metadata envelope
   - HTTP/1.1 pin through OpenCodex provider transport
        |
        v
relay.mirasim.ai
```

The provider composes existing protocol translators. It does not fork Anthropic Messages or OpenAI Responses translation.

## Wire invariants

1. Device/control-plane requests are signed with `mrs-sig-v2`, empty metadata and no sealed envelope.
2. Inference requests add session/agent/call metadata, include it in the v2 signature, then seal all Mirasim metadata except `x-mirasim-client` into `x-mirasim-enc`.
3. Relay metadata uses X25519 + HKDF-SHA256 + ChaCha20-Poly1305 (`mrs-seal-v1`).
4. Device tickets come from `POST /v1/device/session`; 404 falls back to access-token signing for one minute, 501 for fifteen minutes.
5. GPT models use `/v1/responses`; Claude models use `/v1/messages`.
6. Existing OAuth account selection must bind access token and device private key from the same stored credential.
7. Mirasim requests pin OpenCodex upstream transport to HTTP/1.1. Lower-case header spelling should be verified separately at wire level because fetch APIs may canonicalize names.
8. Auxiliary inference routes reuse the same signed/sealed transport: Claude `/v1/messages/count_tokens`, GPT `/v1/alpha/search`, and GPT `/v1/responses/compact`.
9. A Claude `[1m]` selector is local routing syntax only. The relay receives the bare model id plus the deduplicated `context-1m-2025-08-07` beta.
10. Signed account roster fields are authoritative over the static fallback catalog and remain account/device-scoped across access-token rotation.

## Delivery order

1. Golden-vector crypto parity.
2. OAuth credential shape, login, refresh and protected device key persistence.
3. Device-ticket and signed/sealed transport.
4. Dual-wire adapter and registry preset.
5. Static fallback catalog.
6. Signed dynamic `/v1/models` + `/v1/model-roster`. **Implemented.**
7. Provider quota via `/v1/limits`. **Implemented.**
8. Native `/v1/responses/compact`. **Implemented.**
9. Claude `count_tokens`, GPT `alpha/search`, and `[1m]` selector parity. **Implemented.**
10. Browser OAuth plus CLI-only email-code login (`--email` / optional `--code`), refresh, and best-effort `/auth/me` identity enrichment. **Implemented.**
11. Wire capture parity and real Claude/Codex acceptance tests. **Synthetic wire tests implemented; real account E2E requires a Mirasim login and is currently blocked because the local auth store has no Mirasim account.**

## Safety boundaries

- Device private keys remain only in `~/.opencodex/auth.json`; management/status projections never expose them.
- Caller-supplied `x-mirasim-*`, authorization and proxy authorization headers are stripped before signing.
- `x-mirasim-probe` is the only provider-owned control header allowlisted after signing; callers cannot inject it through the ordinary request surface.
- The request transport reuses OpenCodex's provider-scoped fetch executor so proxy, egress, timeout and HTTP-version policy stay centralized.
- Protocol golden vectors from the Go reference are the compatibility oracle.

## Intentional host-lifecycle difference

The CPA plugin asks its host to re-enter refresh every five minutes so it can poll `/auth/me`
for subscription-plan drift. OpenCodex's OAuth resolver has no provider-specific periodic refresh
scheduler; adding one solely for Mirasim would leak CPA host semantics into the shared OAuth
lifecycle. The native port therefore keeps `/auth/me` as best-effort login identity enrichment,
uses normal expiry refresh, and force-refreshes the OAuth snapshot after authenticated relay 401s.
The signed live model/roster cache is account/device-scoped rather than access-token-scoped, so a
normal token rotation does not lose the observed Claude thinking shape.
