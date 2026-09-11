# 080 — Phase 6: hardening, documentation sync, and release gate

Unit: `260827_remote_hub` · Phase: 6/6 · Work class: C4 (auth, secrets, relay, release) · Status: implementation-ready

Dependencies: Phases 1–5 are behaviorally complete, including a `clisu-oracle` dogfood
record. This phase hardens the contracts; it does not redesign hub/client roles or introduce
another transport.

Every executable verification command in this document runs on `ssh lidge-ai`, never on
the workstation. Full-suite execution is serialized with other `lidge-ai` suite owners.

## 0. Locked outcome and boundaries

### IN

- Recoverable per-client data-key rotation with a one-time secret response, bounded overlap,
  client-side atomic token-file replacement, explicit commit/abort, and stable `apiKeyId` usage
  attribution.
- Remote-session self-logout plus explicit operator data-key revocation from the hub GUI or,
  only while connected, `ocx connect revoke` with an admin credential. Disconnect performs no
  hub-side revocation, remains available while the hub is offline, and leaves the hub GUI as the
  sole post-disconnect revocation path.
- Pairing issuance/redemption limits, one-use semantics, bounded active state, and safe 429s.
- Protocol negotiation matrix tests covering the v1 compatibility floor and feature detection.
- Adversarial `/v1/catalog` consumer tests for decompressed size, malformed JSON, invalid schema,
  row limits, stale ETags, and no-write failure behavior.
- Fixed-target relay negatives for SSRF, redirect escape, authority confusion, hop-by-hop header
  injection, CL/TE ambiguity, response header stripping, and bounded streaming.
- Public documentation synchronized across every locale currently configured by Starlight.
- Full lidge gate and explicit MAINTAINERS security-review evidence for every auth-surface PR.

### OUT

- No multi-hub replication, failover, public Funnel, generic reverse proxy, VPN replacement,
  identity provider, organization/tenant RBAC, key escrow, usage mirroring, or automatic release.
- No provider-key/OAuth rotation. This phase rotates only per-client data admission keys.
- No data key gains general `/api/*` authority. Rotation uses a transient pairing/admin authority
  and the existing management gate; a data key cannot mint a GUI session or rotate itself.
- No admin-token-to-`gui-session` exchange, including in tests, migration, compatibility, or
  emergency fallback paths.
- No edits to or new imports from remote subsystems into `src/router.ts`,
  `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.
- No body-level `await` in the guarded `src/server/index.ts` startup window.

## 1. Threat model and must-pass controls

| Attacker / failure | Asset at risk | Required control |
| --- | --- | --- |
| Holder of one client data key | Other clients, management, provider keys | Data-only scope; rotation needs transient management authority; same key id never reveals another key. |
| Holder of hub admin token | Browser-consent routes | May rotate/revoke ordinary data credentials, but can never mint or exchange into `gui-session`. |
| Pairing-code guesser/replayer | Remote GUI consent session | High-entropy one-use grant, short TTL, origin binding, per-grant and aggregate attempt caps, immediate consumption. |
| Malicious/compromised hub response | Client filesystem/memory | Decompressed byte cap, schema/row validation, atomic write after validation, LKG retained, no local fallback. |
| Browser controlling relay path/headers | Hub network and credentials | Destination fixed by connection state; route allowlist; redirects blocked; authority and hop-by-hop headers rebuilt. |
| Header-smuggling attempt | Hub request parser/proxy chain | Reject transfer-encoding, conflicting content-length, connection-nominated headers, CR/LF values, and upgrade paths. |
| Protocol-skewed peer | Local client files / silent misroute | Negotiate before any local write; reject incompatible floors with explicit upgrade error; unknown features stay off. |
| Rotation crash between hub and client | Client availability | Old and pending keys overlap for a bounded window; commit only after new-key probe; abort/expiry preserves old key. |
| Disconnected client whose data key still exists | Hub data admission | Disconnect changes local state only and reminds the operator to delete the key from the hub GUI's **Integrations → API Keys** page; that GUI is the sole post-disconnect revocation path. |
| Logs/evidence | Tokens, codes, identities | Record ids/prefixes/counts/status only; privacy scan; no raw secret, email, Origin query, request body, or account id. |

Security level: ASVS L2 for the remote management/session surface. Applicable architecture,
session, access-control, validation, secret-rotation, CORS, error, and API checks must be attached
to the security review; a generic checklist tick with no test/evidence link is insufficient.

## 2. Diff-level file-change map

All existing paths were verified against the 2026-08-28 tree. Paths under `src/client/` and the
remote-session/pairing owners are Phase-2–4 dependencies; those directories are absent on the
planning base and must exist before Phase 6 begins. If an earlier phase deliberately chose a
different exact owner path, amend this file mechanically before implementation rather than adding
a second owner.

### 2.1 Key rotation, self-logout, and operator revocation

| Path | Change | Exact responsibility |
| --- | --- | --- |
| `src/types/config.ts` | MODIFY | Extend `OcxApiKeyEntry` with an optional, secret-bearing pending-rotation record; keep stable id/name/createdAt. |
| `src/config.ts` | MODIFY | Validate/degrade pending rotation independently so one malformed pending record cannot reset providers or revoke the current key. |
| `src/server/auth-cors.ts` | MODIFY | Admit an unexpired pending key under the same configured `apiKeyId`; never return or serialize its secret. |
| `src/server/management/api-key-rotation.ts` | NEW | Single owner for start/commit/abort/expiry cleanup and constant-time rotation-id comparison. |
| `src/server/management/oauth-account-routes.ts` | MODIFY | Add the three rotation operations next to existing `/api/keys` CRUD. Existing GET continues to mask all secrets; key deletion remains an explicit operator action. |
| `src/server/management/session-routes.ts` | NEW | `POST /api/session/logout` self-revocation route; requires the current `gui-session` and CSRF. Admin token receives 403, not a promoted session. |
| `src/server/management-api.ts` | MODIFY | Wire `handleSessionRoutes` and the narrow session-control dependency into `ManagementContext`. |
| `src/server/management/context.ts` | MODIFY | Carry only the current-session logout interface, never the raw admin token or session map. |
| `src/server/management-auth.ts` | MODIFY | Export a narrow current-session invalidation helper for explicit self-logout; preserve one shared auth predicate and add no key binding to pairing grants or sessions. |
| `src/client/connect.ts` | MODIFY | Implement `ocx connect rotate`: transient authority, start rotation, atomically replace token file, validate new key, commit, and restore+abort on failure; allow `ocx connect revoke` only while connected and source its id solely from persisted `apiKeyId`. |
| `src/client/hub-client.ts` | MODIFY (Phase-3 owner) | Add bounded rotation/revoke management calls, authenticated catalog key-id probe, and redacted errors beside the existing ready/key/catalog calls. |
| `src/client/state.ts` | MODIFY | Validate and persist `pendingOperation: {kind:"rotate",rotationId,newKeyIssuedAt,oldKeyBackupPath}` through the full backup/replace/probe/commit or recovery chain; never persist admin/pairing authority or old/new secret. |
| `src/cli/connect.ts` | MODIFY (Phase-3 owner) | Parse `rotate` and connected-only operator `revoke`, enforce exact stdin flags, reject literal/env secret/id forms, and render redacted recovery status. |
| `src/lib/service-secrets.ts` | MODIFY (Phase-3 owner) | Own `.prev` creation, restoration, and orphan handling as `writeTokenBackup` / `restoreTokenBackup` / `removeOrphanTokenBackup`, reusing the token file's owner-only, regular-file, fsync, and atomic-replace rules. |
| `src/cli/access.ts` | MODIFY | Add management-side `ocx access key rotate <id>` start/commit/abort UX with one-time secret warning; no literal secret flags. |
| `src/cli/registry.ts` | MODIFY | Document rotation command shapes and transient-authority requirement. |
| `gui/src/pages/ApiKeys.tsx` | MODIFY | Load pending status, start/commit/abort rotation, and render the new secret exactly once. |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY | Accessible rotation confirmation/status/error UI; distinguish pending, committed, expired, and aborted outcomes. |
| `gui/src/i18n/en.ts` | MODIFY | Canonical rotation/session strings and `TKey`. |
| `gui/src/i18n/de.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/fr.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/ja.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/ko.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/ru.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/tr.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/zh-TW.ts` | MODIFY | Locale parity. |
| `gui/src/i18n/zh.ts` | MODIFY | Locale parity. |
| `tests/api-keys-routes.test.ts` | MODIFY | Rotation route contract, masking, pending overlap, commit, abort, expiry, malformed inputs, and delete invalidation. |
| `tests/data-plane-admission-identity.test.ts` | MODIFY | Current and pending secret map to one id; expired/committed/aborted secrets do not admit. |
| `tests/api-key-attribution.test.ts` | MODIFY | Traffic before/during/after rotation remains one `apiKeyId` bucket. |
| `tests/server-management-auth.test.ts` | MODIFY | Explicit session self-logout, absence of key-bound grant/session invalidation, and admin-token consent refusal. |
| `tests/client-connect.test.ts` | MODIFY (Phase-3 owner) | Rotation/revoke parser flags, issued `apiKeyId` state chain, connected-only revoke/disconnected refusal, `.prev` crash recovery, pending-operation lifecycle, doubly-accepted commit, uncertain commit, and operator-only key deletion. |
| `tests/service-secrets.test.ts` | MODIFY (Phase-3 owner) | `writeTokenBackup` / `restoreTokenBackup` / `removeOrphanTokenBackup` exact-path, owner-only mode/ACL, symlink/refusal, fsync/atomic replacement, orphan crash-window cases (crash BEFORE marker persistence → orphan removed; crash AFTER → recovery gate runs), and redacted failure cases. |
| `gui/tests/apikeys-actions.test.tsx` | MODIFY | Start/commit/abort wire actions and one-time secret handling. |
| `gui/tests/apikeys-mutation-timeout.test.tsx` | MODIFY | Rotation controls recover after bounded network failure. |
| `gui/tests/apikeys-workspace.test.tsx` | MODIFY | Accessible rendered states and confirmations. |
| `gui/tests/locale-parity.test.ts` | VERIFY/MODIFY | All new visible strings exist in every GUI locale. |

### 2.2 Pairing, protocol, catalog, and relay hardening

| Path | Change | Exact responsibility |
| --- | --- | --- |
| `src/server/gui-session.ts` | MODIFY (Phase-2 owner) | Extend the existing digest-only pairing/session owner with bounded attempt stores, source-key derivation, 429 result, and expiry; grants remain independent of data keys. |
| `src/remote/protocol.ts` | MODIFY (Phase-1 owner) | Extend the existing pure parser/interval-compatibility owner with additive feature intersection; no I/O or local writes. |
| `src/client/hub-client.ts` | MODIFY (Phase-3 owner) | Bounded decompressed read, strict remote catalog validation, ETag/LKG handling, and atomic-write precondition. |
| `src/client/hub-relay.ts` | MODIFY (Phase-4 owner) | Fixed-target URL construction, request/response header rebuilding, redirect refusal, body/stream caps, and redacted errors. |
| `tests/server-management-auth.test.ts` | MODIFY (Phase-2 owner) | Deterministic pairing attempt/TTL/capacity/replay/race matrix in the existing primary session suite. |
| `tests/proxy-liveness.test.ts` | MODIFY (Phase-1 owner) | Protocol metadata parsing remains additive while ordinary readiness identity remains strict. |
| `tests/cli-ready-subprocess.test.ts` | MODIFY | Full released-process skew matrix and no-write mismatch outcomes. |
| `tests/remote-catalog.test.ts` | ADD BY PHASE 6 | Oversized/malformed/schema/ETag/LKG/no-write adversarial matrix for the Phase-3 `hub-client` owner. |
| `tests/client-hub-relay.test.ts` | MODIFY (Phase-4 owner) | SSRF, redirect, authority, smuggling, header stripping, and bounded streaming negatives. |
| `tests/bounded-body.test.ts` | MODIFY only if shared helper changes | Reuse exact-cap/one-byte-over/trickle semantics; do not duplicate the helper contract in client tests. |
| `tests/credential-redirect-guard.test.ts` | EXTEND/REUSE | Existing sibling evidence for credential-bearing redirect refusal. |
| `tests/provider-outbound-private-network.test.ts` | EXTEND/REUSE | Existing sibling vocabulary for destination classification; relay remains fixed-target rather than a provider fetch. |
| `tests/cli-ready.test.ts` | EXTEND/REUSE | Existing readiness identity/shape harness for protocol fields. |
| `tests/cli-ready-subprocess.test.ts` | EXTEND/REUSE | Released CLI subprocess compatibility fixtures and no-write rejection. |
| `tests/core-lab-boundary.test.ts` | VERIFY ONLY | Core import graph and synchronous startup window remain green. |

### 2.3 Source-of-truth and public docs

| Path | Change | Exact responsibility |
| --- | --- | --- |
| `structure/01_runtime.md` | MODIFY | Final hub/client protocol, listener, catalog, and relay ownership map. |
| `structure/02_config-and-codex-home.md` | MODIFY | Client token-file ownership, rotation overlap, disconnect reminder plus hub-GUI-only post-disconnect revocation, and no usage mirroring. |
| `structure/05_gui-and-management-api.md` | MODIFY | Final credential classes, issuance ladder, revocation, rate limits, origin/CSRF, and admin consent refusal. |
| `structure/06_docs-and-release.md` | MODIFY | Correct the locale inventory and record the remote-hub release gate. |
| `structure/09_client-integrations.md` | MODIFY | Remote connection journal/restore, direct data path, fixed relay, and launcher-scoped Claude behavior. |
| `docs-site/astro.config.mjs` | MODIFY | Final Remote Hub sidebar label/translations for every configured locale. |

The roadmap's “5 locales” count is stale. `docs-site/astro.config.mjs` currently declares eight
site locales: root English, `fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, and `tr`. Phase 6 must not
drop the later Russian, Japanese, or Turkish trees merely to satisfy the older count.

New translated guide files (English was created in Phase 5):

- `docs-site/src/content/docs/fr/guides/remote-hub.md`
- `docs-site/src/content/docs/ko/guides/remote-hub.md`
- `docs-site/src/content/docs/zh-cn/guides/remote-hub.md`
- `docs-site/src/content/docs/zh-tw/guides/remote-hub.md`
- `docs-site/src/content/docs/ru/guides/remote-hub.md`
- `docs-site/src/content/docs/ja/guides/remote-hub.md`
- `docs-site/src/content/docs/tr/guides/remote-hub.md`

Existing pages to synchronize in all eight trees:

- CLI lifecycle/connect/service:
  `docs-site/src/content/docs/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/fr/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/ko/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/zh-cn/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/zh-tw/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/ru/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/ja/reference/cli/lifecycle.md`,
  `docs-site/src/content/docs/tr/reference/cli/lifecycle.md`.
- Server/runtime config:
  `docs-site/src/content/docs/reference/configuration/server.md`,
  `docs-site/src/content/docs/fr/reference/configuration/server.md`,
  `docs-site/src/content/docs/ko/reference/configuration/server.md`,
  `docs-site/src/content/docs/zh-cn/reference/configuration/server.md`,
  `docs-site/src/content/docs/zh-tw/reference/configuration/server.md`,
  `docs-site/src/content/docs/ru/reference/configuration/server.md`,
  `docs-site/src/content/docs/ja/reference/configuration/server.md`,
  `docs-site/src/content/docs/tr/reference/configuration/server.md`.
- Management/data contracts:
  `docs-site/src/content/docs/reference/management-api.md`,
  `docs-site/src/content/docs/fr/reference/management-api.md`,
  `docs-site/src/content/docs/ko/reference/management-api.md`,
  `docs-site/src/content/docs/zh-cn/reference/management-api.md`,
  `docs-site/src/content/docs/zh-tw/reference/management-api.md`,
  `docs-site/src/content/docs/ru/reference/management-api.md`,
  `docs-site/src/content/docs/ja/reference/management-api.md`,
  `docs-site/src/content/docs/tr/reference/management-api.md`.
- Dashboard two-plane/session/usage behavior:
  `docs-site/src/content/docs/guides/web-dashboard.md`,
  `docs-site/src/content/docs/fr/guides/web-dashboard.md`,
  `docs-site/src/content/docs/ko/guides/web-dashboard.md`,
  `docs-site/src/content/docs/zh-cn/guides/web-dashboard.md`,
  `docs-site/src/content/docs/zh-tw/guides/web-dashboard.md`,
  `docs-site/src/content/docs/ru/guides/web-dashboard.md`,
  `docs-site/src/content/docs/ja/guides/web-dashboard.md`,
  `docs-site/src/content/docs/tr/guides/web-dashboard.md`.

English is canonical. Translations may be concise, but must preserve warnings, config keys,
defaults, command flags, endpoint names, and the “admin token never grants consent” statement.

## 3. Per-client key rotation contract

### 3.1 Persisted shape

```ts
export interface OcxPendingApiKeyRotation {
  id: string;          // random opaque rotation id, compared constant-time
  key: string;         // pending data secret; never serialized by GET/list/status
  createdAt: string;
  expiresAt: string;
}

export interface OcxApiKeyEntry {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  pendingRotation?: OcxPendingApiKeyRotation;
}
```

One configured id owns at most one pending rotation. The overlap TTL is 10 minutes. The old
and pending keys both admit data during that window and both attribute to the same id. Expiry
removes only the pending key; the old key remains authoritative. A process restart reloads the
durable pending state and applies the same expiry rule.

### 3.2 Pure owner signatures

```ts
export type ApiKeyRotationStart = {
  id: string;
  name: string;
  key: string;         // returned once by start only
  rotationId: string;
  expiresAt: string;
};

export function startApiKeyRotation(
  config: OcxConfig,
  keyId: string,
  now?: number,
): ApiKeyRotationStart | { error: "not-found" | "already-pending" };

export function commitApiKeyRotation(
  config: OcxConfig,
  keyId: string,
  rotationId: string,
  now?: number,
): { ok: true } | { error: "not-found" | "expired" | "mismatch" };

export function abortApiKeyRotation(
  config: OcxConfig,
  keyId: string,
  rotationId: string,
): boolean;
```

Routes stay under the existing management auth:

```text
POST   /api/keys/rotate          {id}                -> 201 + one-time key
POST   /api/keys/rotate/commit   {id,rotationId}     -> 200
DELETE /api/keys/rotate          {id,rotationId}     -> 200
```

Unknown fields are rejected. Error envelopes distinguish not found (404), conflict/already
pending or mismatched/expired (409), invalid body (400), and busy persistence (existing 503).
No response except successful start contains the pending secret.

### 3.3 Client transaction

`ocx connect rotate` requires one transient `--pairing-code-stdin` or
`--admin-token-stdin`; neither is persisted. It performs:

```ts
pendingOperation?: {
  kind: "rotate";
  rotationId: string;
  newKeyIssuedAt: string;
  oldKeyBackupPath: string;
};
```

The Phase-3 client-config reader validates all four fields before recovery can run.
`src/lib/service-secrets.ts` is the sole `.prev` I/O owner through
`writeTokenBackup` and `restoreTokenBackup`; the coordinator does not open, chmod, copy,
or replace the backup directly.

1. Read current key id and current token into memory; write the old token to
   `<tokenfile>.prev` through `writeTokenBackup`, with the same owner-only 0600/ACL rules
   and fsync it.
2. Start rotation; receive pending secret once, then persist
   `pendingOperation: {kind:"rotate",rotationId,newKeyIssuedAt,oldKeyBackupPath}` before
   replacement.

   Crash window between steps 1 and 2: a `.prev` file with NO persisted `pendingOperation`
   is an orphan duplicate of the still-active secret. Startup/status therefore checks the
   inverse gate too: `.prev` present + no rotate `pendingOperation` → the rotation never
   started on the hub, the live token file is authoritative — call
   `removeOrphanTokenBackup` (owner-only unlink with the same symlink/regular-file
   refusals) and log one redacted line. Activation scenario: kill the CLI between backup
   write and marker persistence; next `ocx connect status` removes the orphan and reports
   clean state (covered in tests/service-secrets.test.ts and tests/client-connect.test.ts).
3. Write pending secret to a same-directory owner-only temp, harden it with the same
   `serviceApiTokenFilePath()` rules, fsync, and atomically replace the token file.
4. Probe authenticated `/v1/catalog` with the new key and verify the expected client key id via
   the safe response/diagnostic contract.
5. Commit rotation. Commit invalidates old-key admission only; pairing grants and GUI sessions
   are not key-bound. An already-admitted in-flight turn may complete; the next old-key request
   is 401. After verified commit, delete `<tokenfile>.prev` and clear `pendingOperation`.
6. If steps 2–5 fail before a confirmed commit, restore the old token atomically through
   `restoreTokenBackup`, abort the pending rotation, then delete the backup and clear the
   operation — but only when the restore and abort are both confirmed. If the commit outcome
   is uncertain, follow the recovery gate below rather than probing directly: the identity
   comparison comes first, because two candidates holding the same key both probe
   successfully and would otherwise be read as a completed issuance. Never replay commit,
   and never delete a candidate, without evidence that survives that comparison.

On startup/status, `src/client/state.ts` treats a rotate `pendingOperation` as a recovery gate:
verify that `oldKeyBackupPath` is exactly `<tokenfile>.prev` and require an owner-only regular
file.

**Compare the two candidates' identities before probing anything.** If the live token and
`.prev` carry the same identity, the process stopped after `pendingOperation` was persisted
but before the token was replaced. Both candidates are the old key, so both probe
successfully — and a "both accepted" rule would read that as a completed issuance and commit
a rotation that never happened, permanently losing the new key. Identical candidates
therefore mean pre-replacement: never commit and restore nothing.

What happens next is constrained by two facts. The new secret is returned exactly once, so
if it was issued it is already unrecoverable from disk; and startup/status holds no
management authority, so it cannot ask the hub anything. Recovery at startup/status
therefore **stops** — it does not "resume," because nothing at that point is able to.
It reports the exact state, leaves both candidates and `pendingOperation` intact, and
names the command the operator runs next.

Resumption belongs to the next `ocx connect rotate`, which carries fresh transient
authority. That command sees the stored `rotationId`, confirms its abort with the hub,
and only then starts a new rotation. It is not blocked by the `already-pending` rule
(§ rotate contract), because confirming and clearing the stranded operation is precisely
what it is doing. If the abort cannot be confirmed, it stops with the evidence preserved
rather than starting a second rotation on top of an unresolved one.

Only when the candidates differ does probing decide anything, and only a confirmed authority
may act:

- New and old both accepted: issuance completed, overlap still pending. Commit the new key
  with the stored `rotationId`.
- New only: commit already took effect. Clear the operation.
- Old only: issuance did not take effect. Restore and abort.
- Neither accepted, a probe that fails for a reason other than rejection, or any state the
  above does not name: stop with an exact recovery instruction. Delete nothing.

If an abort or restore itself fails, the uncertainty is retained rather than papered over:
keep both candidates and the `pendingOperation` record, and report which step could not be
confirmed. A restore performed without confirmed authority can install the wrong generation
and is worse than stopping.

A concurrent `ocx connect status` never deletes a backup belonging to an in-flight rotation.
Recovery only acts on a `pendingOperation` it can prove is abandoned.

The GUI exposes the same lifecycle for an operator updating a client manually, with explicit
copy-once and commit-after-client-probe wording. Closing the modal does not imply commit; pending
state remains visible and abortable until expiry.

## 4. Session self-logout contract

Phase-2 pairing grants and `GuiSessionRecord` remain independent of data-key ids. Rotation,
disconnect, and key deletion therefore do not implicitly log out a browser session.

```ts
export interface ManagementSessionControl {
  revokeCurrent(req: Request): boolean;
}

export function createManagementSessionControl(
  state: ManagementAuthState,
): ManagementSessionControl;
```

`handleManagementAPI` receives this narrow current-session control (directly or through
`ManagementContext`), not the session map and never the admin token.
`POST /api/session/logout` requires
`principal === "gui-session"`, same browser Origin, and CSRF. Admin-token calls return 403.

`ocx connect revoke --admin-token-stdin` exists only while connected: it requires valid connected
state, reads the exact `apiKeyId` copied from issuance into that state, accepts no id override, and
uses the transient admin credential to delete that key. Disconnected, invalid, or mismatched state
fails before a hub request. `ocx disconnect` performs local restore only and sends no hub revocation
request; its output names the hub GUI's **Integrations → API Keys** page and reports that revocation
remains outstanding. Once disconnect clears client state, that hub GUI page is the sole revocation
path. Explicit GUI self-logout remains available independently.

## 5. Pairing rate limits

The Phase-2 `src/server/gui-session.ts` owner remains the only grant store. Add no generic middleware and no timer on
the standalone/core request path.

```ts
export interface PairingAttemptContext {
  ingress: "public" | "hub-management";
  peerAddress: string | null;
  tailscaleUser: string | null; // populated only by trusted management ingress
  browserOrigin: string;
}

export type PairingAttemptResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: "grant" | "source" | "capacity" };
```

Fixed starting limits (configurable downward only is unnecessary in v1):

- Grant TTL: Phase-2 short TTL, capped at 10 minutes.
- One successful redemption consumes immediately before session return.
- Five failed redemption attempts burn that grant.
- Ten failed attempts per source key in 10 minutes produce 429; source key is allowlisted
  Tailscale identity on trusted ingress, otherwise immediate peer address, otherwise the global
  anonymous bucket.
- At most 128 live grants and 1,024 source buckets. Capacity refusal is 429 and creates no grant.
- Expired grant/source entries are pruned synchronously on pairing operations; no core timer.
- `Retry-After` is integer seconds, bounded by the remaining window, and contains no identity.
- Constant-time code comparison; generic invalid/expired/consumed response; no existence oracle.
- Pairing grants have no client-key association; rotation, key deletion, and disconnect do not
  scan or revoke the grant store.

Rate-limit logs contain only reason, ingress class, and aggregate count. No code, raw IP,
Tailscale user/email, Origin, token, or account id.

## 6. Protocol skew matrix

Phase 1's wire fields remain `protocol`, `minimumClientProtocol`, and `managementUrl`; Phase 6
adds optional additive `features: string[]`. Protocol v1 is the compatibility floor. Negotiation is pure and
must run before catalog download, token-file writes, injector preflight, journal writes, or state
persistence.

```ts
export interface RemoteReadyMetadata {
  protocol: number;
  minimumClientProtocol: number;
  managementUrl: string;
  features?: string[];
}

export type RemoteProtocolCompatibility =
  | { ok: true; metadata: RemoteReadyMetadata; features: Set<string> }
  | { ok: false; reason: "invalid" | "hub-too-new" | "hub-too-old"; message: string };

export function checkRemoteProtocolCompatibility(
  value: unknown,
  client?: { protocol: number; minimumHubProtocol: number; features?: readonly string[] },
): RemoteProtocolCompatibility;
```

Required matrix:

| Hub descriptor | Client | Activation | Expected |
| --- | --- | --- | --- |
| p1/min1/baseline | p1/min1 | first v1 pair | Accept baseline. |
| p2/min1/A+B | p1/min1/A | newer dev hub, latest v1 client | Accept p1 behavior; feature intersection = A. |
| p2/min2 | p1/min1 | hub dropped v1 floor | Reject `hub-too-new` before write. |
| p1/min1 | p2/min2 | dev client requires newer hub | Reject hub-too-old before write. |
| p1/min1/unknown-X | p1/min1 | additive unknown feature | Accept; unknown feature remains disabled. |
| missing/zero/NaN/fraction/negative/min>protocol or invalid `managementUrl` | p1 | malformed-input class (`400`), never a version mismatch | Exact Phase-1 `invalid` message; zero local writes. |
| valid descriptor, `/readyz` pending/failed | any | startup not ready | Do not negotiate or write; preserve existing readiness behavior. |

The guaranteed live pair is dev hub ↔ latest published protocol-v1 client and the reverse.
Until a release with `connect` exists, fixture tests and release-shaped package candidates are
preflight only; they do not satisfy the live published-pair gate recorded in 070 §8.4.

## 7. Catalog adversarial contract

The remote consumer owns the Phase-1 `MAX_REMOTE_CATALOG_BYTES` 32 MiB **decompressed** body cap
and a 2,000 model-row cap. Use the existing bounded-response helper when
its API can express this without importing `src/server/responses/core.ts`; otherwise add a client
leaf that depends only on `src/lib/bounded-body.ts`.

Validation order:

1. Status/redirect: only 200; redirect is refused, not followed. `/v1/catalog` carries no
   validator (Phase 1, D2), so the client sends no conditional request and a 304 is a
   protocol error rather than a cache hit.
2. Content type is JSON-compatible; content length above cap rejects early, but streamed bytes are
   still counted because length may be absent or false.
3. Read at most cap+1 decompressed bytes; exactly cap is allowed, one byte over cancels/discards.
4. Parse JSON once. Top level must be a plain object with `models` array.
5. `models.length <= 2000`; every row is a plain object with a non-empty printable `slug` string;
   reject NUL/control characters and duplicate slugs. Preserve additive unknown fields after the
   required shape passes.
6. Serialize/write only after complete validation. Failed refresh retains the exact LKG bytes and
   stale age; no local provider fallback and no partial file.
7. A 304 is a protocol error in every case. The client never issued a conditional request,
   so a hub answering 304 is either misconfigured or being impersonated; treat it as a
   failed refresh that retains the exact LKG bytes, never as an empty catalog.

Adversarial tests include: forged small Content-Length with oversized chunks, gzip/decompressed
oversize fixture, exact-cap and cap+1, fragmented trickle, malformed/truncated/UTF-8 JSON, null,
array top level, missing/non-array models, 2,001 rows, non-object row, empty/control/duplicate slug,
unexpected future fields, an unsolicited 304, an unsolicited `ETag` on the 200, and
filesystem write failure after validation.
Every rejection asserts token/catalog/state/journal bytes are unchanged.

## 8. Relay SSRF and header-smuggling negatives

`src/client/hub-relay.ts` is not a general proxy. Its destination is the validated
`connectionState.managementUrl` captured when the listener starts. A request cannot supply or
override scheme, host, port, userinfo, fragment, DNS result, or redirect target.

### 8.1 URL/path rules

- Accept only relative paths in the Phase-4 allowlist: session bootstrap and the explicitly
  supported `/api/*` management namespace.
- Reject absolute-form URLs, scheme-relative `//host`, backslashes, userinfo, fragments,
  percent-decoded authority/path confusion, encoded slash/backslash traversal, and any path that
  normalizes outside the allowlist.
- Resolve against the fixed management origin, then assert protocol/hostname/port equal the fixed
  origin before fetch.
- `redirect:"manual"`/`"error"`; every 3xx is an error and Location is never followed or returned
  with credentials.
- Private/tailnet destinations are allowed because the operator selected the hub; SSRF prevention
  is fixed authority, not a blanket public-IP rule.

### 8.2 Request headers and body

Build a fresh allowlist. Preserve only required content negotiation plus Phase-2 session/origin/CSRF
headers. Never forward caller `Host`, `Forwarded`, `X-Forwarded-*`, `Tailscale-User-*`, cookies,
proxy auth, upgrade, or data-plane authorization. The relay's management session credential is
attached by the trusted client owner, not copied from arbitrary browser input.

Strip the standard hop-by-hop set and every header named by `Connection`: `connection`,
`keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
`transfer-encoding`, and `upgrade`. Reject any request carrying Transfer-Encoding, multiple or
invalid Content-Length, CL/TE together, CR/LF in a header value, unsupported method, or body above
the management cap. Do not rely on Fetch normalization as the only smuggling defense; tests call
the pure validator with raw tuples for otherwise-unconstructible header shapes.

### 8.3 Response rules and streaming

- Rebuild response headers and strip hop-by-hop headers, `Set-Cookie`, proxy auth, server identity
  headers, Tailscale identity, and connection-nominated headers.
- Preserve safe content type, retry-after, and approved CORS/session bootstrap metadata only.
- Relayed session, bootstrap, and management responses are rewritten to
  `Cache-Control: no-store` and have `ETag` and `Last-Modified` removed. The relay does
  not pass an upstream validator through, and does not honor a conditional request against
  one.

  A previous revision preserved upstream `cache control` and `ETag` on relayed responses.
  That reintroduces the Phase-1 defect one layer up: relayed responses vary by hub session
  and client identity, so a preserved strong validator lets a store revalidate one
  identity's representation for another — and the relay sits in exactly the position where
  an intermediary cache is most likely to exist. The relay is not the right place to prove
  an identity-partitioned cache key, so it does not carry a validator at all.
- Enforce Phase-4 management body caps. Phase-6 streaming uses backpressure and abort propagation;
  it must not buffer an unbounded response or continue after browser disconnect.
- Errors name only status/category and fixed hub label. No destination URL query, session token,
  admin token, response body, or identity header reaches logs.

Negative test servers bind loopback only. No test reaches cloud metadata, public internet, LAN, or
the user's configured real hub.

## 9. Test plan and activation matrix

Existing siblings to extend are listed in §2. Tests created by earlier phases remain their owners;
Phase 6 extends them rather than creating parallel “hardening2” files.

| Conditional path | Constructible activation | Required observation |
| --- | --- | --- |
| rotation start | Existing key, no pending rotation, admin/session authority | New key returned once; old+pending both admit under same id; list masks both. |
| second start | Existing unexpired pending rotation | 409; no third secret/state change. |
| client commit | New key written + authenticated catalog succeeds | Pending promoted atomically; old next request 401; id/usage bucket stable; `.prev` deleted and pending operation cleared; sessions/grants unchanged. |
| client write/probe fail | Fail backup/temp write, hardening, rename, or new-key probe | Old file restored/unchanged from `.prev`; pending aborted or expires; old key remains valid. |
| uncertain commit/crash | Drop commit response or restart with pending operation | Compare candidate identities FIRST. Differing candidates: both accepted commits the current new key with stored `rotationId`, new-only finalizes committed state, old-only restores+aborts, both rejected stops without deletion. |
| pre-replacement crash | Persist `pendingOperation`, then stop before the token is replaced, so the live token and `.prev` hold the same key | Identical candidates are detected before any probe. No commit, no restore, no deletion; both files and `pendingOperation` survive and recovery stops with the operator instruction. The old "both probes accepted implies commit" reading is what this row keeps dead — it would commit a rotation that never happened and lose the new key permanently. |
| unconfirmed abort | Rotation reaches installed-new-token state, then the abort request fails transiently | Neither candidate is deleted and `pendingOperation` survives naming the unconfirmed step. No generation is restored on unconfirmed authority. |
| status during rotation | Run `ocx connect status` while `rotateConnectedClientKey` awaits `/api/keys/rotate` | The in-flight `.prev` backup is not deleted and the rotation completes normally. |
| stranded-operation resume | After a pre-replacement crash, run `ocx connect rotate` | The stored `rotationId` is confirmed aborted with the hub before a new rotation starts; `already-pending` does not block this path. An unconfirmable abort stops with evidence preserved rather than starting a second rotation. |
| pending expiry | Fake clock past 10 minutes | Pending rejected/removed; old accepted. |
| connected operator revoke | Valid connected state + `ocx connect revoke --admin-token-stdin` | CLI reads the issuance-derived `apiKeyId` from state, accepts no id argument, and revokes that key; sessions/grants remain unchanged. |
| post-disconnect revoke | Disconnect clears local client state while its hub key remains | CLI revoke refuses before any request; output points to hub GUI **Integrations → API Keys**, the sole post-disconnect revocation path. |
| self logout | GUI session + Origin + CSRF | Current session removed; replay 401. Admin-token call 403. |
| pairing bad guesses | Same grant/source repeated with fake clock | Fifth grant failure burns; source threshold yields 429 + bounded Retry-After; no identity leak. |
| pairing replay/race | Two concurrent valid redemptions | Exactly one session; other generic failure. |
| pairing capacity | Fill 128 grants / 1,024 buckets | Refusal/prune behavior bounded; no eviction of a newer live grant to admit attacker input. |
| newer compatible hub | p2/min1 + p1 client | Feature intersection only; no unsupported path. |
| incompatible floor | client<hub minimum or hub<client minimum | Explicit upgrade error before every local write. |
| malformed protocol | Invalid `/readyz` fields | Malformed error; no catalog/token/inject/state write. |
| oversized catalog | Content-Length lie or chunked cap+1 | Cancel/discard, LKG unchanged, no fallback. |
| malformed/schema catalog | Each §7 shape | Precise safe error class, LKG unchanged. |
| unsolicited 304 | Hub answers 304 to an unconditional request, with and without an existing LKG | Treated as a protocol error in both cases; LKG unchanged where present, no empty catalog written, no local provider fallback. |
| relay URL override | Absolute/scheme-relative/encoded authority path | Reject before fetch; fixed hub sees zero requests. |
| relay redirect | Fixed hub returns 3xx to attacker | No follow, no credential at target. |
| request smuggling | Raw CL/TE, duplicate CL, Connection-nominated secret header | Reject/strip before fetch. |
| response smuggling | Upstream hop-by-hop/Set-Cookie/Connection nomination | Browser response omits all prohibited headers. |
| disconnect mid-stream | Browser abort while hub streams | Upstream abort observed, bounded buffered bytes, no lingering relay task. |

## 10. Public documentation acceptance

The Remote Hub guide in all eight locales must cover:

- standalone/hub/client roles and direct client→hub data flow;
- `ocx connect`, status, sync, rotate, disconnect, and offline restore;
- auto-issued per-client token in the existing protected token file, never config.toml;
- connected usage = hub store filtered to this `apiKeyId`; disconnected usage = local store;
  no mirroring;
- loopback management ingress, Tailscale Serve, exact `allowedTailscaleUsers`, pairing, and the
  requirement that pairing runs over loopback or HTTPS only — plaintext HTTP carries no
  credential and there is no opt-in that changes this;
- admin token ordinary-management scope and permanent inability to mint consent sessions;
- systemd/launchd, Docker volume/secret/probes, headless OAuth, rotation, rollback, and protocol
  upgrade errors;
- troubleshooting for hub down, stale catalog, rotated token/`.prev` recovery, protocol mismatch,
  lost pairing, plain HTTP, remote-session logout/expiry, and outstanding operator revocation.

Reference pages list exact config keys/defaults and endpoint auth. No page may call `/healthz`
readiness, claim usage mirroring, suggest putting a token on argv, suggest `0.0.0.0:10101`, trust
arbitrary Tailscale headers, or imply a published Docker image exists.

## 11. MAINTAINERS security-review checklist

Every PR that touches management auth, pairing, key rotation, CORS, relay, service secrets,
Docker secret guidance, or dependency installation is security-review-required under
`MAINTAINERS.md`.

- [ ] PR targets `dev` (or the open parent head for an intentional stacked child) and uses every
  section of `.github/PULL_REQUEST_TEMPLATE.md`.
- [ ] At least one non-author maintainer approves; both current maintainers review the auth/relay
  PRs when practical. Author self-approval is not counted.
- [ ] GUI PR description includes a current screenshot or the maintainer-controlled waiver.
- [ ] Threat model names data/admin/session/pairing credentials, ingress, relay, client files,
  attacker capabilities, and accepted local-process limitation.
- [ ] Admin token cannot mint/exchange/refresh a GUI session in any normal, compatibility,
  migration, error, or recovery branch.
- [ ] Data keys authorize only the data matrix and `/v1/catalog`; rotation endpoints remain
  management-authenticated and transient authority is never persisted.
- [ ] Session Origin/serverOrigin/browserOrigin, CSRF, TTL, renewal, explicit logout, absence of
  key-bound invalidation,
  replay, and wrong-ingress tests are linked.
- [ ] Pairing entropy, one-use, TTL, attempt/capacity limits, race behavior, 429, and redacted
  logging tests are linked.
- [ ] Relay destination fixation, redirect refusal, URL normalization, request/response header
  rebuilding, CL/TE negatives, cap/backpressure, and abort tests are linked.
- [ ] Catalog cap applies after decompression; malformed/schema inputs produce zero local writes.
- [ ] Rotation crash/uncertain-commit path cannot strand a client or accept both secrets after
  terminal commit.
- [ ] `bun run privacy:scan` is green and diff/evidence contain no token, pairing/OAuth code,
  raw email/account id, request body, or raw usage row.
- [ ] Core Lab boundary and synchronous `startServer` guards remain unmodified and green.
- [ ] All correct Codex/CodeRabbit findings are fixed/resolved at the exact reviewed head.
- [ ] Rollback steps are executable and preserve the OpenCodex volume/config while revoking the
  affected remote credential/session surface.

An unresolved item is a release blocker. Do not convert a red named gate into an exception inside
the same readiness report.

## 12. Acceptance criteria

- [ ] Per-client rotation is recoverable through `pendingOperation` + `<tokenfile>.prev`, bounded,
  stable-id-attributed, secret-safe, and invalidates only old-key admission after commit.
- [ ] Session self-logout, local-only disconnect, connected-only CLI revoke, and hub-GUI-only
  post-disconnect revoke are distinct; admin-token consent remains 403.
- [ ] Pairing attempt and capacity state are bounded, deterministic under fake time, one-use under
  races, and privacy-safe.
- [ ] Every protocol matrix row is reachable and proves no-write behavior before incompatibility.
- [ ] Catalog consumer rejects every oversized/malformed/schema adversary while retaining exact LKG
  bytes and never falling back to local providers.
- [ ] Relay cannot change authority, follow redirects, forward identity/hop-by-hop headers, accept
  CL/TE ambiguity, or buffer unbounded streams.
- [ ] English + seven translated Remote Hub guides and all four affected reference page families
  are synchronized with code and sidebar.
- [ ] `structure/` reflects the final shipped architecture and correct eight-locale source of truth.
- [ ] Focused tests, full runtime suite, privacy scan, GUI build/lint, and docs build are green on
  the exact SHA on `lidge-ai`.
- [ ] `clisu-oracle` dogfood and constructible release↔dev compatibility receipts are attached, or
  the live published-pair gate remains explicitly open and blocks release.
- [ ] Required MAINTAINERS security reviews are recorded for the exact final heads.

## 13. Verification — remote only

No local tests, typecheck, builds, lint, privacy scan, or docs build. Pin one exact SHA and run the
focused gates first on `lidge-ai`:

```bash
VERIFY_SHA="$(git rev-parse HEAD)"
ssh lidge-ai "set -eu
  export PATH=\$HOME/.bun/bin:\$PATH
  repo=\$HOME/ocx-verify/remote-hub-p6
  git -C \$repo fetch origin
  git -C \$repo checkout --detach $VERIFY_SHA
  test \"\$(git -C \$repo rev-parse HEAD)\" = \"$VERIFY_SHA\"
  cd \$repo
  bun install --frozen-lockfile
  bun run typecheck
  bun test tests/api-keys-routes.test.ts \
    tests/data-plane-admission-identity.test.ts \
    tests/api-key-attribution.test.ts \
    tests/server-management-auth.test.ts \
    tests/client-connect.test.ts \
    tests/service-secrets.test.ts \
    tests/remote-catalog.test.ts \
    tests/client-hub-relay.test.ts \
    tests/bounded-body.test.ts \
    tests/credential-redirect-guard.test.ts \
    tests/provider-outbound-private-network.test.ts \
    tests/proxy-liveness.test.ts \
    tests/server-live.test.ts \
    tests/cli-ready.test.ts \
    tests/cli-ready-subprocess.test.ts \
    tests/core-lab-boundary.test.ts
  cd gui
  bun install --frozen-lockfile
  bun test tests/apikeys-actions.test.tsx \
    tests/apikeys-mutation-timeout.test.tsx \
    tests/apikeys-workspace.test.tsx \
    tests/locale-parity.test.ts
"
```

Then run the mandatory full gate on the same detached SHA, still on `lidge-ai`:

```bash
ssh lidge-ai "set -eu
  export PATH=\$HOME/.bun/bin:\$PATH
  cd \$HOME/ocx-verify/remote-hub-p6
  test \"\$(git rev-parse HEAD)\" = \"$VERIFY_SHA\"
  bun run typecheck
  bun run test
  bun run privacy:scan
  bun run build:gui
  bun run lint:gui
  cd docs-site
  bun install --frozen-lockfile
  bun run build
"
```

Record command, exact SHA, exit code, and pass/fail counts. Do not rerun a passing unchanged gate.
If a full gate is red, reproduce the identical failure against the untouched baseline and inspect
the matching CI partition before classifying it; never call a red result environmental by assertion.

Final live evidence runs on `clisu-oracle`/MacBook per 070 §8 after the remote gates. It proves
health, readiness, authenticated catalog, one routed response, remote session, consent refusal,
rotation, usage slice, disconnect/local store, rollback, and both constructible protocol directions.
