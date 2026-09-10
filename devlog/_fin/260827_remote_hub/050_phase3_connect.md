# 050 — Phase 3: connect/disconnect/sync and client routing targets

Unit: `260827_remote_hub` · Phase: 3 · Status: diff-level implementation plan

Depends on Phase 1's `src/remote/protocol.ts`, protocol-v1 `/readyz`, and
data-authenticated `/v1/catalog` contracts and Phase 2's one-time pairing exchange at
`POST /opencodex-session`. Pairing never authenticates `/api/keys` directly: connect
first consumes it into an origin-bound GUI session, then uses that session once for the
existing key POST. This phase does not weaken either contract.

## 0. Structural decision

### Context

Today `src/codex/inject.ts` derives one local target from `hostname + port`,
`src/codex/sync.ts` always gathers the local provider catalog, and
`src/cli/claude.ts` always ensures and targets a local proxy. A connected machine
instead needs one immutable remote target and one admission secret, while standalone
output must remain byte-for-byte unchanged.

### Chosen move

- Add a leaf `src/client/` subsystem that owns persisted connection-state parsing,
  hub HTTP calls, and the connect transaction.
- Generalize Codex generation around a `CodexRoutingTarget`, but retain the current
  numeric overloads as compatibility wrappers. The wrappers construct the same
  standalone target and therefore emit identical bytes.
- Extend the injection journal with an optional durable client owner. A successful
  connect outlives the short-lived connect CLI PID; startup preserves the journal only
  while validated `runtimeRole === "client"` and `config.client.apiKeyId` match that
  owner. Missing/mismatched state restores exactly as today's dead-PID recovery does.
- Make CLI dispatch choose standalone sync or connected sync before entering
  `src/codex/sync.ts`. Connected sync never calls local provider discovery.
- Reuse the existing `POST /api/keys` owner in
  `src/server/management/oauth-account-routes.ts:596`; do not create a second key
  store or key-generation route. Admin authenticates that POST directly; pairing can
  reach it only through Phase 2's session exchange and full origin/CSRF predicate.
- Store the issued secret only at `serviceApiTokenFilePath()`
  (`src/lib/service-secrets.ts:5`). Persist only its key id and SHA-256 ownership
  fingerprint under `config.json.client`.

### Rejected alternatives

- Persisting the data key in `config.json` or `$CODEX_HOME/config.toml`: both widen
  secret exposure and violate the existing `env_key`/shim contract.
- Pointing connected sync at `refreshCodexModelCatalog()`: a hub outage would then
  silently repopulate the catalog from local providers and route traffic to the wrong
  authority.
- Adding a second CLI switch in `src/cli/index.ts`: command registration is now
  registry-driven (`src/cli/registry.ts`, `src/cli/dispatch.ts`); bypassing it would
  drift help, aliases, and dispatch parity.

### Dependency direction and blast radius

`src/cli/* -> src/client/* -> config/codex/service-secret leaves`. No new client
module is imported by `src/router.ts`, `src/server/lifecycle.ts`, or
`src/server/responses/core.ts`. `src/server/index.ts` is not changed in this phase, so
its synchronous `Bun.serve` activation window is untouched. Blast radius: CLI,
Codex/Claude machine integration, persisted config schema, and the existing API-key
management endpoint tests; no provider request-path change.

## 1. IN / OUT

### IN

- `ocx connect <url>`, `ocx disconnect`, `ocx connect status [--json]`, and connected
  fields in existing `ocx status [--json]`.
- Protocol-v1 readiness negotiation through Phase 1's parser/predicate, with the
  guaranteed compatibility floor:
  current dev hub ↔ latest released client, with same-major feature detection.
- Per-client key auto-issuance through exact `POST /api/keys`, using an admin token
  directly once or a Phase-2 pairing grant indirectly through one transient GUI session;
  none of those management credentials is persisted.
- Owner-only service token file, bounded/atomic catalog placement, injector preflight,
  rollback, and final atomic `runtimeRole + config.json.client` commit.
- Codex target generalization, connected `ocx sync` with no local fallback, Claude
  launcher targeting, and offline journal-backed disconnect.

### OUT

- Client-mode HTTP listener, `/api/machine/*`, hub relay, and GUI two-plane wiring
  (Phase 4 / doc 060).
- Deployment recipes and Tailscale Serve setup (Phase 5).
- Rotation UI, orphan-key reconciliation while the hub is unreachable, multi-hub,
  catalog adversarial hardening beyond the Phase-1 contract, and release docs
  (Phase 6).
- Provider execution on the client, local usage mirroring, or any write to `src/lab/`.

## 2. File-change map

Every existing path below was verified in the current tree. For NEW client paths,
`src/` exists and Phase 3 creates the approved `src/client/` feature leaf from
`010_design.md`; the other NEW parents already exist.

| Action | Exact path | Diff-level change |
|---|---|---|
| NEW | `src/client/state.ts` | Parse/validate `runtimeRole + config.json.client`, including the optional rotation `pendingOperation`; expose fail-closed connected/absent/invalid/mismatched states, and atomically commit/clear both keys through config mutation. |
| NEW | `src/client/hub-client.ts` | Validate/normalize URLs; bounded `GET /readyz`, `POST /api/keys`, `GET /v1/catalog`; protocol/capability checks; redact all credential-bearing errors. |
| NEW | `src/client/connect.ts` | Transaction coordinator, connected sync, rollback, and offline disconnect. No argv or presentation logic. |
| NEW | `src/cli/connect.ts` | Parse connect/disconnect/status arguments, read exactly one `--pairing-code-stdin` or `--admin-token-stdin` credential, call the coordinator, and render redacted human/JSON output. |
| MODIFY | `src/types/config.ts` | Add `OcxClientConnectionConfig`, its optional non-secret rotation `pendingOperation`, and top-level `OcxConfig.client?`; the secret itself is not a field. |
| MODIFY | `src/config.ts` | Add schema and field-scoped persistence behavior for `client`, including `pendingOperation`; malformed-present client state must be diagnosable and must never degrade into standalone routing. |
| MODIFY | `src/lib/service-secrets.ts` | Add atomic owner-only write and fingerprint-checked removal beside existing path/read helpers. |
| MODIFY | `src/codex/inject.ts` | Add `CodexRoutingTarget`; thread it through provider table, `env_key`, root URL, profile, preflight, journal witness, and inject while retaining byte-compatible standalone overloads. |
| MODIFY | `src/codex/journal.ts` | Add backward-compatible durable client ownership; reconcile a dead process journal only when no matching committed client state exists. |
| MODIFY | `src/cli/index.ts` | Pass fail-closed client ownership into pre-start journal reconciliation; command registration itself remains registry/dispatch-owned. |
| MODIFY | `src/cli/dispatch.ts` | Register lazy connect/disconnect runners; branch `sync` on client state before `syncModelsToCodex`; invalid or connected-but-unusable state fails without local discovery. |
| MODIFY | `src/cli/registry.ts` | Add canonical command metadata and usage for `connect` and `disconnect`. |
| MODIFY | `src/cli/help.ts` | Add both commands to the compact top-level usage list; detailed help remains registry-derived. |
| MODIFY | `src/cli/status.ts` | Add a redacted connection block: state, URLs, protocol, key id, selected clients, catalog age, and token-file ownership state; never token bytes/fingerprint. |
| MODIFY | `src/cli/claude.ts` | Resolve standalone vs connected launcher target; connected mode skips local proxy startup and injects hub `ANTHROPIC_BASE_URL` + client token only for that exact target. |
| MODIFY | `src/claude/gateway-cache.ts` | Generalize cache refresh from numeric local port to explicit base URL + admission token while retaining the numeric wrapper. |
| MODIFY | `tests/config.test.ts` | Extend config round-trip/degradation coverage for valid, absent, unknown-field, and malformed-present `client`. |
| MODIFY | `tests/cli-registry.test.ts` | Assert registry/help ownership for connect/disconnect. |
| MODIFY | `tests/cli-dispatch.test.ts` | Assert lazy dispatch and standalone/connected sync selection. |
| MODIFY | `tests/cli-help.test.ts` | Assert compact and subcommand help without credential-bearing argv forms. |
| MODIFY | `tests/cli-status-json.test.ts` | Assert redacted connected/invalid/disconnected status JSON. |
| MODIFY | `tests/api-keys-routes.test.ts` | Extend exact `POST /api/keys` authority matrix for admin and a fully authorized Phase-2 GUI session; a raw pairing grant is rejected and response secret remains one-time. |
| MODIFY | `tests/codex-inject.test.ts` | Add explicit-target generation plus standalone golden-byte parity. |
| MODIFY | `tests/codex-inject-integration.test.ts` | Add preflight/commit/restore tests for a remote target and absolute catalog path. |
| MODIFY | `tests/codex-catalog-restore.test.ts` | Add version-1 journal compatibility and durable-client-owner restore/preserve cases. |
| MODIFY | `tests/cli-start-journal-order.test.ts` | Prove matching committed client ownership preserves the connect journal after the connect PID exits; absent/mismatched state still restores. |
| MODIFY | `tests/claude-cli.test.ts` | Add connected target, user-override, token non-forwarding, and no-local-start cases. |
| MODIFY | `tests/claude-gateway-cache.test.ts` | Add remote model URL/token and local-wrapper parity. |
| NEW | `tests/client-connect.test.ts` | Transaction, protocol, credential, catalog, rollback, connected sync, and offline disconnect matrix. |
| NEW | `tests/service-secrets.test.ts` | 0600/ACL-aware write, fingerprint, symlink/refusal, changed-file removal refusal, and redacted failures. |

Verified dependencies, not Phase-3 edits: `src/server/management/oauth-account-routes.ts`
owns `/api/keys`; `src/server/management/api-access.ts` only builds displayed data-plane
endpoints; `src/codex/paths.ts:29` owns
`$CODEX_HOME/opencodex-catalog.json`; Phase 1's `src/remote/protocol.ts` owns the
readiness parser/compatibility strings and `src/server/catalog-download.ts` owns
`MAX_REMOTE_CATALOG_BYTES` plus the `/v1/catalog` wire bytes.

## 3. Persisted config and public signatures

### `src/types/config.ts`

```ts
export type OcxConnectedClientId = "codex" | "claude";

export interface OcxClientConnectionConfig {
  serverUrl: string;              // canonical origin; no path/query/hash/userinfo
  managementUrl: string;          // canonical origin; may differ from serverUrl
  managementTransport: "direct" | "relay";
  selectedClients: OcxConnectedClientId[];
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
  apiKeyId: string;               // exact IssuedClientKey.id; attribution/revoke id, not secret
  tokenFingerprint: string;       // lowercase SHA-256; ownership check only
  protocolVersion: 1;
  connectedAt: string;            // ISO-8601
  catalogEtag?: string;
  catalogSyncedAt?: string;
  pendingOperation?: {
    kind: "rotate";
    rotationId: string;
    newKeyIssuedAt: string;
    oldKeyBackupPath: string;
  };
}

export interface OcxConfig {
  // existing fields unchanged
  runtimeRole?: "standalone" | "hub" | "client"; // Phase 1 owner
  client?: OcxClientConnectionConfig;
}
```

The parser rejects unknown selected-client ids, non-origin URLs, protocol values other
than 1, duplicate client ids, malformed timestamps, and non-64-hex fingerprints. A present
`pendingOperation` must have exactly `kind: "rotate"`, a non-empty `rotationId`, a valid
`newKeyIssuedAt`, and the exact owner-approved `<tokenfile>.prev` backup path; malformed or
partial pending state makes the client state invalid rather than dropping the recovery gate.
Forward-compatible unknown object keys are preserved on unrelated config writes. A raw
`client` key that is present but invalid is `kind: "invalid"`, not `absent`; start,
sync, Claude launch, and status must refuse local-provider fallback in that state.
`runtimeRole === "client"` requires a valid `client` object and a present client object
requires that role. `hub` plus `client`, or one half missing, is a mismatch and fails
closed.

### `src/client/state.ts`

```ts
export type ClientConnectionState =
  | { kind: "disconnected" }
  | { kind: "connected"; value: OcxClientConnectionConfig }
  | { kind: "invalid"; reason: string }
  | { kind: "mismatched"; reason: string };

export function readClientConnectionState(): ClientConnectionState;
export function commitClientConnection(
  state: OcxClientConnectionConfig,
): "committed" | "unchanged";
export function clearClientConnection(
  expectedApiKeyId: string,
): "committed" | "absent" | "conflict";
```

`commitClientConnection()` writes `runtimeRole: "client"` and `client` in one config
mutation. `clearClientConnection()` removes `client` and removes the role only when it
is still `client`, in one mutation. `readClientConnectionState()` inspects the raw
top-level keys before relying on a repaired/fallback config DTO. This is the guard that
makes malformed-present or half-present state fail closed instead of appearing
disconnected.

### `src/lib/service-secrets.ts`

```ts
export interface PersistedServiceApiToken {
  path: string;
  fingerprint: string;
}

export function writeServiceApiTokenFile(token: string): PersistedServiceApiToken;
export function removeServiceApiTokenFileIfOwned(
  expectedFingerprint: string,
): "removed" | "absent" | "changed";
```

Write is temp → `0600`/Windows ACL harden → rename at the exact
`serviceApiTokenFilePath()`. It refuses symlink targets and a non-client pre-existing
secret. Removal rereads and hashes the bounded regular file; a changed file is never
deleted. Neither function returns or logs the token after the write.

### `src/codex/inject.ts`

```ts
export interface CodexRoutingTarget {
  baseUrl: string; // canonical absolute .../v1
  requiresAdmissionToken: boolean;
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN";
}

export function standaloneCodexRoutingTarget(
  port: number,
  config?: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener">,
): CodexRoutingTarget;

export interface InjectCodexOptions {
  // existing fields unchanged
  routingTarget?: CodexRoutingTarget;
  journalOwner?: { kind: "process" } | { kind: "client"; apiKeyId: string };
}
```

Existing `injectCodexConfig(port, config, options)`, `buildProviderTableBlock(...)`,
`buildOpenaiBaseUrlLine(...)`, and `buildProfileFile(...)` exports retain their current
call forms as overloads. Their implementations normalize through one target-aware
builder. With no `routingTarget`, the bytes are exactly current output, including EOL,
comments, provider names, `env_key = "OPENCODEX_API_AUTH_TOKEN"`, profile wording,
and loopback root-override behavior. With a connected target,
`requiresAdmissionToken: true` selects the provider-table form independent of whether
the URL hostname itself looks loopback.

### `src/codex/journal.ts`

```ts
export type JournalOwner =
  | { kind: "process"; pid: number }
  | { kind: "client"; apiKeyId: string };

export interface ReconcileJournalOptions {
  activeClientApiKeyId?: string;
}

export function reconcileJournal(options?: ReconcileJournalOptions): boolean;
```

Existing version-1 `{ pid }` journals parse as process-owned. A new journal records the
owner without removing the existing hashes/preimages. `reconcileJournal()` preserves a
client-owned journal only when a separately validated `runtimeRole === "client"` and
`config.client.apiKeyId` match; invalid, absent, or different state restores it. This
avoids both failure modes: a
successful connect is not undone merely because its CLI PID exited, while a crash before
the final client-state commit cannot leave durable remote routing behind.

### `src/client/hub-client.ts`

```ts
export type OneTimeConnectCredential =
  | { kind: "admin"; value: Uint8Array }
  | { kind: "pairing-grant"; value: Uint8Array };

export interface ConnectGuiSession {
  token: string;
  csrfToken: string;
  browserOrigin: string;
  serverOrigin: string;
}

export interface IssuedClientKey {
  id: string;
  key: string;
  createdAt: string;
  name: string;
}

export function normalizeHubOrigin(input: string): string;
export function fetchHubReady(
  serverUrl: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<{ status: "ready" | "pending" | "failed"; metadata: RemoteReadyMetadata }>;
export function exchangeConnectPairingGrant(
  managementUrl: string,
  browserOrigin: string,
  grant: Uint8Array,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<ConnectGuiSession>;
export function issueClientKey(
  managementUrl: string,
  credential:
    | { kind: "admin"; value: Uint8Array }
    | { kind: "gui-session"; value: ConnectGuiSession },
  name: string,
  options?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<IssuedClientKey>;
export function downloadClientCatalog(
  serverUrl: string,
  admissionToken: string,
  options?: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch },
): Promise<{ kind: "fresh"; body: string }>;
```

`fetchHubReady()` parses through Phase 1's `parseRemoteReadyMetadata()` and evaluates
through `checkRemoteProtocolCompatibility()`; it does not define a second protocol
shape, constants, or mismatch strings. Both URLs accept only `http:`/`https:`, reject
credentials/query/hash and non-root paths
(a terminal `/v1` input normalizes to the server origin).

No credential travels over non-loopback plaintext HTTP. That covers the admin
credential, the pairing grant, the resulting session, and the issued client key alike.
An earlier revision let a grant use HTTP when the caller passed
`--allow-insecure-http` and the hub set `remoteGui.allowInsecureHttp === true`, on the
theory that requiring both sides to opt in made it deliberate. Deliberateness is not the
control that matters: the grant is still readable by anything on the path, and the
session it mints is reusable. Both the flag and the CLI option are removed, and the
client refuses before transmission rather than warning after it.

Redirects are rejected. Bodies and timeouts are bounded. Errors carry status and safe
code, never response/header secrets.

`POST /api/keys` remains the exact key authority. The request body is only a validated,
bounded `name`; admin uses the ordinary management header. Pairing uses strict
`POST /opencodex-session` with the future machine-GUI browser origin, then the returned
session token + `X-OpenCodex-GUI-Origin` + CSRF authorize the key POST. A raw pairing
grant cannot access any `/api/*` route. An admin token is never submitted to the session
exchange and therefore never mints or becomes `gui-session`.

The successful issuance response's `IssuedClientKey.id` is copied unchanged into
`OcxClientConnectionConfig.apiKeyId` at the final state commit. That stored field is the
single id consumed by journal ownership, connected status/display, Usage attribution, and
Phase 6's connected-only `ocx connect revoke`; no revoke key id is accepted from argv.

### `src/client/connect.ts`

```ts
export interface ConnectOptions {
  serverUrl: string;
  managementUrl?: string;
  credential: OneTimeConnectCredential;
  selectedClients: OcxConnectedClientId[];
  managementTransport: "direct" | "relay";
  noSync?: boolean;
}

export interface ClientConnectDeps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function connectClient(
  options: ConnectOptions,
  deps?: ClientConnectDeps,
): Promise<OcxClientConnectionConfig>;
export function syncConnectedClient(
  options?: { restartCodex?: boolean },
  deps?: ClientConnectDeps,
): Promise<{ catalogWritten: boolean; cacheSynced: boolean; injected: boolean; stale: boolean }>;
export function disconnectClient(
  options?: { keepCatalog?: boolean },
): Promise<{ restored: boolean; tokenRemoved: boolean; catalogRemoved: boolean }>;
```

### CLI contract

```text
ocx connect <url> [--management-url <url>]
            [--pairing-code-stdin | --admin-token-stdin]
            [--clients codex,claude]
            [--management-transport direct|relay]
            [--no-sync]
ocx connect status [--json]
ocx disconnect [--keep-catalog] [--json]
```

Phase 6 may extend this command family with `ocx connect revoke --admin-token-stdin`, but
that command is valid only while `readClientConnectionState()` is connected. It resolves
the exact key solely from `config.client.apiKeyId` and rejects disconnected, invalid, or
mismatched state before any hub request.

There is deliberately no `--token <value>`, `--admin-token <value>`, pairing-code
positional form, or credential environment-variable form. Exactly one of
`--pairing-code-stdin` and `--admin-token-stdin` uses the bounded stdin helper. It decodes
the credential once at read into the coordinator-owned `Uint8Array`; no display path renders
that value. Parse errors redact unknown bare values and all credential-shaped option values.
The transient credential remains in memory until the connect transaction commits or rollback
finishes; successful key issuance alone is not a terminal outcome. At that terminal boundary,
release references and overwrite the coordinator's `Uint8Array` copy; immutable argv/stdin
string copies are best-effort GC.

## 4. Connect transaction and rollback

The observable order is fixed:

1. Normalize `serverUrl`/optional `managementUrl`; reject an already connected,
   role/client-mismatched, or malformed-present state. Preflight the token target and
   refuse a foreign pre-existing service token before network or file writes.
2. `GET <serverUrl>/readyz`; require `status=ready`, protocol-v1 compatibility, and
   advertise/derive the management origin.
3. Validate transport/credential combination. Admin: POST
   `<managementUrl>/api/keys` directly. Pairing: consume the grant once at
   `<managementUrl>/opencodex-session` using the future localhost machine-GUI Origin,
   then use the returned session + CSRF once at `/api/keys`. Hold `{id,key}` only in
   memory.
4. Snapshot pre-existing owned client artifacts; atomically write the issued key only
   to `serviceApiTokenFilePath()` and retain its fingerprint.
5. `GET <serverUrl>/v1/catalog` with the issued data key, validate bounded JSON, then
   atomically replace `$CODEX_HOME/opencodex-catalog.json`.
6. Run `injectCodexConfig(..., { validateOnly: true, routingTarget, catalogPath })`.
7. Unless `--no-sync`, inject selected Codex state under the existing journal/write-lock
   transaction with `{ journalOwner: { kind: "client", apiKeyId } }`. Prepare Claude
   launcher state only; no persistent Claude settings write.
8. Commit `runtimeRole: "client"` + `config.json.client` together and last. That state
   commit makes the connection visible to future commands.

Failure at steps 4–8 removes the newly written token, restores prior owned catalog
bytes, calls journal restore for any committed Codex injection, and leaves both client
config fields absent. The still-in-memory admin credential or exchanged GUI session
attempts exact `DELETE /api/keys` for the just-created id. If hub cleanup is unreachable,
the failure reports only the safe key id and exact revoke action; it never prints the
key. Machine-local rollback success is mandatory and remote cleanup inability is
explicit, never hidden as full rollback. Only after that cleanup attempt completes does
the coordinator release references and overwrite its transient credential `Uint8Array`;
the success path does so immediately after the final state commit. Immutable string copies
remain best-effort GC rather than a zeroization guarantee.

`--no-sync` still performs readiness, key issuance, token placement, catalog download,
and final state commit, but does not mutate Codex/Claude client files. The next
connected `ocx sync` is the sole apply path.

## 5. Mode-aware sync and launch behavior

### `ocx sync`

- `client.kind === disconnected`: run today's `syncModelsToCodex(...)` path unchanged.
- `client.kind === invalid`: exit non-zero before proxy discovery, provider discovery,
  catalog write, or injection.
- `client.kind === connected`: read and fingerprint-check the service token, request
  `/v1/catalog` unconditionally, and inject the saved `CodexRoutingTarget`.
  `/v1/catalog` carries no validator (Phase 1, D2), so the client sends no
  `If-None-Match` and never receives a 304. There is no conditional-fetch state to keep
  correct, and no way for a cached representation to cross client keys.
- Connected timeout/5xx keeps last-known-good catalog and reports stale age; it does
  not gather local providers. Missing/changed token file and 401 are hard failures and
  do not inject or fall back.

### Claude launcher

Connected `ocx claude` does not call `ensureProxyForClaude()` and does not target the
Phase-4 machine listener. It derives:

```ts
interface ClaudeRoutingTarget {
  baseUrl: string;             // client.serverUrl, no /v1 suffix
  admissionToken: string;      // token file, memory only
}
```

`buildClaudeEnv` retains its numeric standalone overload and adds an explicit-target
overload. Default connected launch sets `ANTHROPIC_BASE_URL=<serverUrl>` and
`ANTHROPIC_AUTH_TOKEN=<client key>`, plus the existing discovery/model variables.
An explicit user `ANTHROPIC_BASE_URL` still wins; if it differs from the connected hub,
the hub admission token is removed before spawn so it cannot follow the user override.
Gateway cache refresh uses `<serverUrl>/v1/models?limit=1000&ids=cli`; context-window
metadata comes from the downloaded catalog, not a management-token `/api/*` request.

### Disconnect

Disconnect is local-authoritative and works with the hub offline:

1. Read valid connected state and verify `apiKeyId`/token fingerprint ownership.
2. Call existing journal-backed native restore (`restoreNativeCodexAsync` /
   `restoreJournalState`); preserve user-edited foreign fields exactly as today.
3. Remove the token only when its fingerprint still matches.
4. Remove only the OpenCodex-owned catalog unless `--keep-catalog`.
5. Clear `config.json.client` + the `client` runtime role together and last (absence
   resolves to standalone).

After successful local disconnect, human and JSON output retain the safe prior `apiKeyId`
only long enough to remind the operator: revoke the still-valid key from the hub GUI's
**Integrations → API Keys** page. Once state is cleared, CLI revoke is unavailable; the hub
GUI is the sole post-disconnect revocation path.

If restore is partial or the token changed, state is not cleared and the command names
the conflicting artifact. This avoids claiming disconnected while Codex still points at
the hub or deleting a replacement secret. Remote key revocation is not required for
offline completion; Phase 6 owns stale-key/rotation UX.

## 6. Test plan

Tests use temp `OPENCODEX_HOME`/`CODEX_HOME`, injected fetch, and synthetic credentials.
No test sends live hub traffic or reads the developer's homes.

| Test file | Required cases |
|---|---|
| `tests/client-connect.test.ts` (NEW) | URL canonicalization; exact stdin-flag exclusivity and literal/env credential rejection; Phase-1 ready parser/mismatch strings; ready/pending/failed; p2/min1 acceptance and p2/min2 rejection; management URL advertisement; admin HTTPS direct key POST; pairing HTTPS session exchange then key POST; issued id copied unchanged through state/status/revoke ownership; dual-opt-in pairing HTTP; admin HTTP refusal; raw grant rejection at `/api/keys`; credential retained through commit/rollback, never rendered, then coordinator `Uint8Array` overwritten and references released; bounded catalog; atomic role+state commit; each rollback point; no-sync; connected 200/304/401/timeout sync; no local discovery fake called; offline disconnect, post-disconnect hub-GUI reminder, and partial restore. |
| `tests/service-secrets.test.ts` (NEW) | Exact path, 0600, Windows ACL seam, atomic replacement, symlink refusal, fingerprint, changed-file non-removal, no token in errors. |
| `tests/codex-inject.test.ts` | Current standalone goldens byte-equal; explicit HTTPS target emits exact `base_url`, provider table, `env_key`; loopback-looking connected URL still requires admission; malformed target refused before journal. |
| `tests/codex-inject-integration.test.ts` | Validate-only has zero writes; target commit records journal ownership; offline restore returns exact preimage; partial write rollback. |
| `tests/codex-catalog-restore.test.ts`, `tests/cli-start-journal-order.test.ts` | Version-1 process journals retain current behavior; client journal survives only a matching final state; absent/invalid/mismatched state restores after dead connect PID. |
| `tests/config.test.ts` | Valid client round-trip including a complete rotation `pendingOperation`; malformed/missing `rotationId`, timestamp, or backup path fails closed; atomic role+client pair; unknown keys preserved; absent remains standalone; half-present/malformed remains fail-closed; no secret field accepted/emitted. |
| `tests/api-keys-routes.test.ts` | Admin and full GUI-session predicates create once; raw pairing grant and incomplete origin/CSRF reject; list/patch never echo secret. Phase-2 session tests remain the admin-never-mints-session oracle. |
| `tests/cli-registry.test.ts`, `tests/cli-dispatch.test.ts`, `tests/cli-help.test.ts` | Registry/dispatch/help parity; no credential argv form; connected sync calls only remote coordinator; invalid client refuses. |
| `tests/cli-status-json.test.ts` | Stable redacted status in disconnected/connected/invalid/token-changed/catalog-stale states. |
| `tests/claude-cli.test.ts`, `tests/claude-gateway-cache.test.ts` | Standalone parity; connected direct target; no local ensure; service token precedence; user destination strips hub token; remote model cache URL/token; no management credential dependency. |
| `tests/core-lab-boundary.test.ts` | Existing three protected import roots and synchronous `startServer` checks remain green. |

## 7. Acceptance criteria with activation grounding

| ID | Constructible activation scenario | Expected result |
|---|---|---|
| P3-A1 | Disconnected temp home; HTTPS hub ready on protocol 1; admin token arrives through stdin; `/api/keys` and `/v1/catalog` succeed. | One key is issued, token exists only in owner-only service file, catalog and injection commit, and `runtimeRole=client` + `config.client` are written together and last with key id/fingerprint only. |
| P3-A2 | Same as A1, but a Phase-2 pairing grant bound to the future localhost GUI origin is supplied. | Grant is consumed once at `/opencodex-session`; returned GUI session + CSRF performs exact key POST; raw grant on `/api/keys` and replay fail; no transient credential persists. |
| P3-A3 | Non-loopback HTTP management URL with a pairing grant, including a tree that still carries a legacy `--allow-insecure-http` argument or a persisted `remoteGui.allowInsecureHttp: true`. | Refused before any credential is transmitted, in every combination. The removed CLI option is rejected as unknown rather than silently accepted, and the legacy config key grants nothing. The admin credential over HTTP is likewise refused before transmission. |
| P3-A4 | `/readyz` returns `{protocol: 2, minimumClientProtocol: 2}` or status pending/failed. | Clear upgrade/not-ready error; zero key POSTs and zero local writes. |
| P3-A5 | Key POST returns 401/403/409 or malformed/oversized JSON. | No token/catalog/journal/config writes and no secret in diagnostics. |
| P3-A6 | Token, catalog, injector preflight, inject commit, or final role+state commit is fault-injected in turn. | Prior machine bytes are restored at every point; neither `runtimeRole=client` nor visible `client` remains; remote orphan cleanup status is explicit by safe key id only. |
| P3-A7 | Existing standalone config runs every current injector golden. | Output bytes are identical; no connected-only env/header/config key appears. |
| P3-A8 | Connected state plus valid token; two consecutive syncs. | Each sync fetches unconditionally and atomically updates/injects; no request carries `If-None-Match`; a hub that answered 304 anyway is treated as a protocol error rather than as an empty catalog. The local provider gather fake is never called. |
| P3-A9 | Connected state with hub down, 401, missing token, changed token, or malformed-present client config. | No local-provider fallback and no new local catalog; timeout keeps LKG as stale, credential/state errors fail hard. |
| P3-A10 | Connected Claude launch with no user Anthropic overrides. | Child receives hub base and client token; no local proxy is started; gateway cache uses hub `/v1/models`. |
| P3-A11 | Connected Claude launch with user-owned different `ANTHROPIC_BASE_URL`. | User destination wins and the hub admission token is absent from child env. |
| P3-A12 | Hub unreachable during disconnect with intact journal/token. | Native Codex bytes restore offline, owned token/catalog are removed per flags, and `runtimeRole + client` clear together and last; output names the hub GUI **Integrations → API Keys** page as the sole post-disconnect revoke path. |
| P3-A13 | Disconnect sees changed token or a journal ownership conflict. | Conflicting artifact is preserved, command fails, and connected state remains so status is honest. |
| P3-A14 | Connect injection committed, connect process exited, and matching `runtimeRole=client + config.client.apiKeyId` was committed last; then `ocx start` runs. | Pre-start reconciliation preserves the client journal/routing. If final state is absent, invalid, mismatched, or names another key id, the same journal restores before startup. |
| P3-A15 | `/readyz` returns `{protocol: 2, minimumClientProtocol: 1}` to the protocol-v1 client. | Compatibility succeeds using protocol-v1 behavior; key issuance and connect continue normally. |

## 8. Verification — remote only on `lidge-ai`

No Bun test, typecheck, build, or privacy suite runs on the local Mac. Create the
phase checkout at `/home/lidgeai/codex-runs/260827-remote-hub-phase3`, owned by the
unprivileged `lidgeai` user, install dependencies there, and run:

```bash
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase3 && ./node_modules/.bin/bun run typecheck'\'''
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase3 && ./node_modules/.bin/bun test tests/client-connect.test.ts tests/service-secrets.test.ts tests/config.test.ts tests/cli-registry.test.ts tests/cli-dispatch.test.ts tests/cli-help.test.ts tests/cli-status-json.test.ts tests/api-keys-routes.test.ts tests/codex-inject.test.ts tests/codex-inject-integration.test.ts tests/codex-catalog-restore.test.ts tests/cli-start-journal-order.test.ts tests/claude-cli.test.ts tests/claude-gateway-cache.test.ts tests/core-lab-boundary.test.ts'\'''
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase3 && ./node_modules/.bin/bun run privacy:scan'\'''
```

Before marking the non-trivial PR review-ready, repository policy additionally requires
the full suite on the same remote checkout (never local):

```bash
ssh lidge-ai 'sudo -iu lidgeai bash -lc '\''cd /home/lidgeai/codex-runs/260827-remote-hub-phase3 && ./node_modules/.bin/bun run test'\'''
```

Record remote user, absolute path, HEAD, command exit codes, pass/fail counts, and the
focused/full suite tails in this unit's C-phase evidence. Do not rerun an unchanged
passing command.
