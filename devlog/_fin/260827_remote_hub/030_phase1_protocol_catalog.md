# 030 — Phase 1: protocol negotiation and data-plane catalog

Unit: `260827_remote_hub` · Branch: `codex/remote-hub-design` · Phase: 1 · Status: diff-level plan · Work class: C4

This phase establishes the smallest release-compatible wire contract needed before any
client writes local files. It adds no connect command, no remote GUI, and no client-mode
runtime behavior. All code paths remain standalone-compatible when `runtimeRole` is absent.

## 1. Outcome and fixed contract

- Persisted runtime role key: `runtimeRole?: "standalone" | "hub" | "client"`.
  Absence resolves to `"standalone"`; `getDefaultConfig()` does not start writing the key
  into existing files.
- Protocol constants: `REMOTE_HUB_PROTOCOL = 1` and
  `MINIMUM_REMOTE_CLIENT_PROTOCOL = 1`.
- Exact unauthenticated `GET /readyz` keeps its current status/identity fields and adds:

  ```json
  {
    "protocol": 1,
    "minimumClientProtocol": 1,
    "managementUrl": "https://hub.example.ts.net"
  }
  ```

  `managementUrl` is the canonical origin observed by this request in Phase 1. Phase 2
  changes only its source for hub deployments by preferring
  `hub.managementPublicOrigin`; the field and parser do not change.
- Data-authenticated exact `GET /v1/catalog` returns the same serialized catalog bytes as
  `GET /api/catalog`. It carries **no ETag and no conditional `If-None-Match` support**,
  and never answers 304.

  A previous revision gave this response a strong ETag derived from the bytes plus
  `Cache-Control: private, no-cache`, while also varying the body-adjacent
  `x-opencodex-key-id` by identity. That pairing is unsafe: a strong validator asserts
  that one entity-tag names one representation, but the representation here varies by
  key type and key id. Any store that keys on URL plus validator — a shared intermediary,
  a client cache reused across key rotation, a future hub relay — can serve or revalidate
  one identity's representation to another. `no-cache` does not prevent storage; it only
  forces revalidation, and the revalidation itself is what crosses identities.

  Making the validator safe would require an identity-partitioned cache key and validator
  proven across every store in the path, including ones we do not control. That proof is
  more expensive than the bandwidth a 304 saves on a catalog this size, so the design
  does not attempt it.
- `/v1/catalog` admits only the two forms used by the Codex injector contract:
  `x-opencodex-api-key: <our secret>` or `Authorization: Bearer <our secret>`.
  `x-api-key`, a foreign bearer, the admin token, and no credential are rejected on a
  non-loopback bind. The row is added to `AUTH_MATRIX` with `xApiKey: "rejected"`.
- A `/v1/catalog` response admitted by a configured key includes `x-opencodex-key-id` with
  that key's id on the 200. Environment-token and loopback paths, plus rejected
  and unauthenticated responses, never include this header. Revalidate the id at emission as
  `^[A-Za-z0-9._-]{1,64}$`; on mismatch omit the header and log one non-secret warning.
  Every successful catalog response includes `Cache-Control: no-store` and no validator.
- A serialized catalog larger than `MAX_REMOTE_CATALOG_BYTES = 32 * 1024 * 1024` is not
  returned over `/v1/catalog`; it fails with HTTP 503 and the stable code
  `catalog_too_large`. The management route continues to expose the same serialized bytes
  for local diagnosis, so the bound does not hide the operator's recovery surface.

## 2. IN / OUT

### IN

- Runtime-role type, read validation, write validation, and explicit default resolver.
- Protocol-v1 metadata in every ready/pending/failed `/readyz` body.
- A parser/compatibility predicate for future `ocx connect`, including additive-field
  tolerance for a dev hub paired with the latest released client.
- Shared catalog serialization, size cap, data-plane admission, and configured-key-only
  `x-opencodex-key-id` attribution. The byte-derived ETag and `If-None-Match` handling
  belong to `/api/catalog` alone; `/v1/catalog` has no validator (§ above).
- Route placement before the unknown-`/v1/*` JSON-404 guard.
- Focused and full remote-only verification commands.

### OUT

- `ocx connect`, client state, per-client key issuance to the owner-only
  `serviceApiTokenFilePath` file, catalog installation, inject/restore, usage filtering,
  and any machine listener (Phases 3–4). No client admission key is written to config.
- `hub.managementPublicOrigin`, remote GUI sessions, pairing, Tailscale identity, and
  management CORS (Phase 2).
- Provider discovery or catalog regeneration. This endpoint serves the current persisted
  Codex catalog only.
- Protocol v2 design, multi-hub negotiation, server-side downgrade, and silent fallback to
  local providers.
- Any import from the new remote modules into `src/router.ts`,
  `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.

## 3. Wire and compatibility contract

### 3.1 Readiness shape

`/readyz` remains exact `GET`, unauthenticated, and 200 only for `status: "ready"`; pending,
failed, and draining remain 503 with `Retry-After: 1`. The new fields are public protocol
metadata only—no path, warning, provider, account, key id, or config payload is exposed.

The current latest-release readiness parser is already additive-field tolerant
(`validateReadyzBody` reads named fields rather than rejecting unknown keys in
`src/server/proxy-liveness.ts:275-297`). Therefore a protocol-v1 dev hub remains a valid
readiness target for the latest released client. New clients parse the three protocol
fields separately before any connect-side mutation.

`managementUrl` rules in this phase:

- It is an HTTP(S) origin only: no path other than `/`, no query, fragment, or userinfo.
- It is derived from the request URL/Host using the same canonical-origin rules as the
  current management surface.
- It is present for standalone, hub, and client roles, because old/new process discovery
  must not branch on shape. Phase 3 decides whether a client role may serve `/readyz`.
- It never trusts `Forwarded` or `X-Forwarded-*`. Phase 2's configured public origin is the
  only TLS-terminator override.

### 3.2 Version parser and exact mismatch strings

The parser accepts additional unknown keys but validates these required values as positive
safe integers and an HTTP(S) origin. Compatibility is an interval intersection:

```text
hub.protocol >= client.minimumHubProtocol
client.protocol >= hub.minimumClientProtocol
```

The v1 client constants are both `1`. Fail before catalog fetch and before any local write.
Exact user-visible strings:

- Hub requires a newer client:
  `OpenCodex hub requires remote protocol {hubMinimum}; this client supports protocol {clientProtocol}. Upgrade ocx on this client.`
- Hub is too old for the client:
  `OpenCodex hub provides remote protocol {hubProtocol}; this client requires at least {clientMinimum}. Upgrade ocx on the hub.`
- Missing/malformed metadata:
  `OpenCodex hub returned invalid remote protocol metadata; upgrade or repair ocx on the hub.`

There is no optimistic assumption that a missing field means v1. Old hubs are explicit
incompatibility for `ocx connect`, while their ordinary standalone readiness remains usable.

### 3.3 Catalog bytes, cache, and admission

One function reads the current catalog, serializes it exactly once with
`JSON.stringify(catalog)`, and returns the resulting UTF-8 bytes. Both routes consume that
result. The test oracle compares the two route bodies byte-for-byte; it does not derive an
expected body by calling the serializer twice.

`/api/catalog` keeps its byte-derived ETag and `If-None-Match` handling: that route is
management-authenticated, loopback-scoped, and its representation does not vary by data
key identity.

`/v1/catalog` does not participate. It emits no ETag, ignores `If-None-Match`, never
returns 304, and carries `Cache-Control: no-store`. The two routes therefore share
serialization and the size bound, but not the validator.

`/v1/catalog` uses `resolveResponsesApiAuth(req, policy)`, not `resolveApiAuth`, because the
former is the existing dedicated-header/our-secret-Bearer matrix and rejects `x-api-key`
(`src/server/auth-cors.ts:465-478`). It performs the existing data-plane origin check after
admission, then sets `x-opencodex-key-id` on the 200 only when the admitted identity is
a configured API key and its id passes `^[A-Za-z0-9._-]{1,64}$` again at emission. A
mismatch omits the header and emits one non-secret warning without the id. Environment-token,
loopback, rejected, and unauthenticated paths never emit the header. No Direct passthrough
exists on this read-only route and no credential is forwarded.

## 4. Diff-level file-change map

All paths below exist in the current tree except the two files marked **NEW**.

| Action | Exact path | Diff-level change |
|---|---|---|
| MODIFY | `src/types/config.ts` | Export `OcxRuntimeRole`; add optional `runtimeRole` to `OcxConfig` beside bind/runtime settings. |
| MODIFY | `src/config.ts` | Add role schema and `runtimeRole` field validation; export `runtimeRole(config)`; reject invalid live candidates while preserving absence as standalone. Add degraded persisted-value diagnostics without deleting providers or `apiKeys`. |
| NEW | `src/remote/protocol.ts` | Own protocol constants, readiness metadata type/parser, `readyProtocolMetadata(config, req)`, management-origin validation, compatibility result, and exact mismatch strings. Phase 1 observes the request origin; accepting config from the start lets Phase 2 prefer `hub.managementPublicOrigin` without changing the consumer signature. This is a passive leaf and imports no router, lifecycle, Responses, provider, or Lab code. |
| NEW | `src/server/catalog-download.ts` | Own `MAX_REMOTE_CATALOG_BYTES`, one persisted-catalog serialization result, byte-derived ETag matching, `/api/catalog` response construction, and bounded `/v1/catalog` response construction. |
| MODIFY | `src/server/management/model-routes.ts` | Replace the inline `/api/catalog` read/`JSON.stringify` block at lines 334–345 with the shared response builder; preserve 404 and `x-opencodex-codex-version`. |
| MODIFY | `src/server/auth-cors.ts` | Add the `/v1/catalog` `AUTH_MATRIX` row with bearer/dedicated accepted and `xApiKey` rejected. Do not change any existing row or credential precedence. |
| MODIFY | `src/server/index.ts` | Add protocol metadata to the current `/readyz` body at lines 991–998 by passing `(config, req)` to the builder. Mount exact `GET /v1/catalog` after readiness/management handling and before the unknown-`/v1/*` guard at line 1604; use `resolveResponsesApiAuth` plus the existing origin policy, add `Cache-Control: no-store` with no validator, and emit `x-opencodex-key-id` on the 200 only for a configured-key identity whose id passes the emission-time header-safe guard. Omit and log once without the id on mismatch. Keep `startServer` synchronous and add no `await` between `Bun.serve` and `labActivationRequired`. |
| MODIFY | `src/server/proxy-liveness.ts` | Keep existing identity/status parsing additive; extend the internal body type/comments so protocol fields are recognized but do not make ordinary `ocx ready` reject a v0/legacy standalone server. Remote compatibility remains in `src/remote/protocol.ts`. |
| MODIFY | `tests/config.test.ts` | Extend the existing config-default/validation sibling tests with absent/default, three valid roles, malformed live candidate, and malformed persisted role preservation cases. |
| MODIFY | `tests/server-live.test.ts` | Extend the existing `GET /readyz` suite (lines 1220+) for exact protocol values on ready/pending/failed/draining, sanitized keys, management origin, method/path negatives, and no-auth behavior. |
| MODIFY | `tests/proxy-liveness.test.ts` | Extend the current strict readiness parser/probe tests to prove additive protocol fields neither invalidate readiness nor bypass identity/status checks. |
| MODIFY | `tests/api-catalog-route.test.ts` | Extend the existing `/api/catalog` sibling suite with fixed fixture bytes and version-header preservation after serializer extraction. |
| MODIFY | `tests/server-auth.test.ts` | Extend live-server auth/order coverage with `/v1/catalog` admission matrix, exact configured-key `x-opencodex-key-id` on the 200, `Cache-Control: no-store`, absence of `ETag`, a request carrying `If-None-Match` still receiving 200 with full bytes, header absence for environment-token/loopback/rejected/unauthenticated paths, invalid-id omission with one id-free log, exact-path/method negatives, foreign/admin bearer rejection, bound overflow, and unknown-`/v1` guard preservation. |
| MODIFY | `tests/api-key-attribution.test.ts` | Extend the existing live `AUTH_MATRIX` loop so `/v1/catalog` is a GET route, each cell reaches the real handler rather than the generic 404, configured-key dedicated/Bearer admission echoes that key's id, and environment/loopback admission does not. |

No other production or test file is in scope. If implementation proves another path is
required, stop the phase and amend this document before editing it.

## 5. New and changed signatures

```ts
// src/types/config.ts
export type OcxRuntimeRole = "standalone" | "hub" | "client";

export interface OcxConfig {
  runtimeRole?: OcxRuntimeRole;
}

// src/config.ts
export function runtimeRole(config: Pick<OcxConfig, "runtimeRole">): OcxRuntimeRole;

// src/remote/protocol.ts
export const REMOTE_HUB_PROTOCOL = 1;
export const MINIMUM_REMOTE_CLIENT_PROTOCOL = 1;

export interface RemoteReadyMetadata {
  protocol: number;
  minimumClientProtocol: number;
  managementUrl: string;
}

export type RemoteProtocolCompatibility =
  | { ok: true; metadata: RemoteReadyMetadata }
  | { ok: false; reason: "invalid" | "hub-too-new" | "hub-too-old"; message: string };

export function readyProtocolMetadata(config: OcxConfig, req: Request): RemoteReadyMetadata;
export function parseRemoteReadyMetadata(value: unknown): RemoteReadyMetadata | null;
export function checkRemoteProtocolCompatibility(
  value: unknown,
  client?: { protocol: number; minimumHubProtocol: number },
): RemoteProtocolCompatibility;

// src/server/catalog-download.ts
export const MAX_REMOTE_CATALOG_BYTES = 32 * 1024 * 1024;

export interface SerializedCatalog {
  bytes: Uint8Array;
  codexVersion?: string;
}

export async function serializePersistedCatalog(): Promise<SerializedCatalog | null>;
export function catalogEtag(bytes: Uint8Array): string;
export function catalogManagementResponse(
  catalog: SerializedCatalog | null,
  req: Request,
  config: OcxConfig,
): Response;
export function catalogDataPlaneResponse(
  catalog: SerializedCatalog | null,
  req: Request,
  policy: RequestPolicyView,
): Response;
```

The shared serializer returns `null` only for the current “catalog not found” state. Read,
parse, or serialization errors remain bounded server failures; they are not converted into
an empty catalog. No function accepts a caller-provided catalog path.

## 6. Acceptance criteria with activation grounding

| ID | Constructible activation scenario | Required result / oracle |
|---|---|---|
| P1-A01 | Load config with no `runtimeRole`. | `runtimeRole(config) === "standalone"`; saved bytes are not rewritten merely by reading. |
| P1-A02 | Validate each explicit role through `validateConfigCandidate`. | `standalone`, `hub`, and `client` are accepted and preserved exactly. |
| P1-A03 | Validate/write an unknown role, then separately load a hand-edited unknown role fixture containing provider and API-key sentinels. | Live write is rejected with a path-specific error; persisted recovery preserves unrelated provider/key state and emits a non-secret diagnostic. |
| P1-A04 | Start a server with a pending gate and request exact unauthenticated `GET /readyz`; repeat after ready, failed, and drain activation. | Existing HTTP/status/Retry-After contract holds and all three protocol fields remain identical across states. |
| P1-A05 | Send POST, OPTIONS, `/readyz/`, and encoded `/readyz%2F`. | Existing deterministic JSON 404 path remains; no protocol document leaks through the GUI fallback. |
| P1-A06 | Feed a v1 document plus unknown future fields to the new parser and to `validateReadyzBody`. | Both accept the document; readiness identity remains strict and remote parser preserves only validated protocol fields. |
| P1-A07 | Feed `{protocol: 2, minimumClientProtocol: 2}` to a protocol-v1 client. | `hub-too-new` and the exact “Upgrade ocx on this client” string are returned before catalog access. |
| P1-A08 | Feed `{protocol: 1, minimumClientProtocol: 1}` to a protocol-v2 client requiring minimum hub protocol 2. | `hub-too-old` and the exact “Upgrade ocx on the hub” string are returned. |
| P1-A09 | Supply zero, omit, mistype, overflow, set minimum above protocol, or give a path-bearing `managementUrl`. | The malformed-input class (`400`) returns `invalid` and the exact malformed-metadata string; it is never classified as a version mismatch and never falls back to protocol 1. |
| P1-A10 | Persist a fixed catalog fixture; call authorized `/api/catalog` and authorized `/v1/catalog`. | Status 200 and response bytes are byte-identical. `/api/catalog` carries its byte-derived ETag; `/v1/catalog` carries `Cache-Control: no-store` and no `ETag`. |
| P1-A11 | Repeat `/v1/catalog` with configured-key dedicated/Bearer admission, environment-token admission, loopback admission, `x-api-key`, foreign Bearer, admin token, and no token; inject an invalid configured key id, repeat the request, and capture logs. | The configured-key 200 carries the exact safe key id. Environment/loopback/rejected/unauthenticated responses omit it; invalid id is omitted with one non-secret warning and no key id appears in logs. No case reaches the generic unknown-route 404. |
| P1-A12 | Call `/v1/catalog` with a matching tag, weak matching tag, tag list, `*`, stale tag, and malformed tag in `If-None-Match`. | Every case returns 200 with the full bytes, no `ETag`, and `Cache-Control: no-store`: the route has no validator to match against, so no request can elicit a 304. The same tags against `/api/catalog` still return 304, proving the removal is scoped to the identity-varying route. |
| P1-A13 | Serialize exactly the cap and cap+1 fixtures through an injected serialization seam. | Exact cap returns 200; cap+1 returns 503 `catalog_too_large`, never a partial body. |
| P1-A14 | Call POST `/v1/catalog`, GET `/v1/catalog/`, and an unrelated `/v1/does-not-exist`. | Every request returns the existing JSON 404 envelope; route ordering does not widen path/method matching. |
| P1-A15 | Run the import-graph and synchronous-window guard after the diff. | No new subsystem is reachable from the three protected core files; `startServer` remains non-async and its guarded window contains no top-level `await`. |
| P1-A16 | Feed `{protocol: 2, minimumClientProtocol: 1}` to a protocol-v1 client. | Compatibility succeeds; only protocol-v1 behavior is enabled. |

## 7. Verification — remote only on `lidge-ai`

Do not run Bun tests, typecheck, or privacy/full-suite gates on the local Mac. The remote
checkout must contain the phase branch and run as the ordinary `lidgeai` user, not root.

Focused implementation gate:

```bash
ssh lidge-ai 'cd ~/Developer/opencodex && bun run typecheck && bun test tests/config.test.ts tests/server-live.test.ts tests/proxy-liveness.test.ts tests/api-catalog-route.test.ts tests/server-auth.test.ts tests/api-key-attribution.test.ts tests/core-lab-boundary.test.ts'
```

Review-ready shared-server gate:

```bash
ssh lidge-ai 'cd ~/Developer/opencodex && bun run test && bun run privacy:scan'
```

`privacy:scan` remains a repository gate, not the runtime-header privacy oracle; P1-A11's
captured-log absence assertion proves that key ids do not reach logs.

Record the remote commit, Bun version, command, exit code, and pass/fail counts in the phase
evidence ledger. Do not repeat a passing command unless code covered by it changes.

## 8. Completion boundary

Phase 1 is complete only when every acceptance row has remote evidence and the route is a
real authenticated catalog response, not merely a health response. Do not begin client-side
writes in this phase. Any protocol-field rename after Phase 1 is a compatibility change and
requires an explicit protocol-version decision.
