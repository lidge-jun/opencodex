# Native main profile switching design spike (#656)

Status: implementation candidate for maintainer and security review

Issue: https://github.com/lidge-jun/opencodex/issues/656

Official Codex reference: `openai/codex@ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`

## Decision summary

The first implementation should be CLI/backend-only and should use these safety boundaries:

1. Support native ChatGPT credentials only when the effective Codex credential store is `file`.
2. Treat the complete native auth envelope as opaque bytes. Parse it for validation, but never rebuild it from Pool fields.
3. Keep exactly one refresh owner. Official Codex owns the active profile; the encrypted OpenCodex vault owns inactive profiles.
4. Move a profile between those owners transactionally. Do not create a second independently refreshable Pool record.
5. Require encrypted storage for inactive profiles, backed by an OS-protected key. There is no plaintext fallback.
6. Bind every vault and switch transaction to one canonical effective `CODEX_HOME`.
7. Refuse a live switch while a native Codex process can still refresh the old credential. Drain OpenCodex `__main__` traffic and require a native Codex restart.
8. Preserve task and history data. Only the active credential and `__main__` runtime-derived state may change.
9. Prove rollback for every failure after the first credential write before opening a behavior-changing PR.
10. Keep GUI work out of the first PR.

This design deliberately rejects `keyring`, `auto`, and `ephemeral` Codex credential modes in v1. Supporting those modes requires an official Codex integration point; directly reproducing Codex keyring internals in TypeScript would be brittle and unsafe.

## Why the Pool credential model cannot be reused

The current Pool record contains the fields OpenCodex needs to route and refresh Pool traffic. It is not the complete native Codex credential record.

The current official Codex `AuthDotJson` includes:

- `auth_mode`
- `OPENAI_API_KEY`
- `tokens`
- `last_refresh`
- `agent_identity`
- `personal_access_token`
- `bedrock_api_key`

The ChatGPT token payload includes the raw ID token, access token, refresh token, and optional account ID. The format can gain fields independently of OpenCodex.

Relevant official definitions:

- [AuthDotJson](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/login/src/auth/storage.rs#L38)
- [TokenData](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/login/src/token_data.rs#L10)

Converting a Pool record into `auth.json` would lose native fields and assign refresh ownership to two independent implementations. That is not a supported conversion path.

## Official Codex storage constraints

Official Codex currently has four credential-store modes:

| Mode | Official behavior | v1 behavior |
| --- | --- | --- |
| `file` | Stores credentials in `$CODEX_HOME/auth.json` | Supported |
| `keyring` | Stores credentials in the keyring and fails if unavailable | Refuse |
| `auto` | Prefers keyring and falls back to `auth.json` | Refuse because the active backend can change |
| `ephemeral` | Keeps credentials in process memory only | Refuse |

The official default is currently `file`. On Windows, the default keyring backend stores encrypted secrets in a local file whose key is in the OS keyring. A successful keyring save can remove `auth.json`.

Relevant official definitions:

- [AuthCredentialsStoreMode](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/config/src/types.rs#L104)
- [AuthKeyringBackendKind](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/config/src/types.rs#L136)
- [Auth storage backends](https://github.com/openai/codex/blob/ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff/codex-rs/login/src/auth/storage.rs#L163)

Therefore, the presence or absence of `auth.json` alone does not identify the official active credential source. The capability probe must resolve the credential mode before any write.

## Threat model

The feature must protect against:

- Token disclosure through logs, CLI output, management responses, crash journals, or diagnostic bundles.
- Writing to a different Codex home than the one shown to the user.
- Losing the original login after malformed input, failed validation, failed rename, failed ACL application, or failed read-back.
- Two components using the same rotating refresh token independently.
- A process crash between the auth-file replacement and the vault metadata update.
- A native Codex process refreshing the source profile while OpenCodex is switching it out.
- Stale in-flight `__main__` responses publishing usage or plan state for the old identity.
- Clearing tasks or history as a side effect of an account switch.
- Treating a missing, malformed, or temporarily unreadable credential as a confirmed logout or identity change.

It does not claim to protect an unlocked account from malware running as the same OS user. The OS credential store and file ACLs are still required to reduce accidental disclosure and offline credential exposure.

## Invariants

### I1. Full-fidelity envelope

OpenCodex stores the exact source bytes and their SHA-256 digest. It may parse a copy for validation, but it must write the original decrypted bytes without serializing a reduced TypeScript shape.

This preserves fields that the installed Codex understands but the installed OpenCodex does not.

### I2. One refresh owner

Credential ownership is stateful:

| Profile state | Credential owner | Refresh allowed by OpenCodex |
| --- | --- | --- |
| Active | Official Codex active store | No |
| Inactive | Encrypted OpenCodex vault | No |
| Staged login | Official Codex in a restricted temporary home | No |
| Switching | Transaction journal under an exclusive switch lock | No |

OpenCodex never calls the OAuth refresh grant for native profiles. The Pool refresh implementation remains Pool-only.

On a successful switch, the target encrypted payload is consumed from the inactive vault record and becomes the official active credential. The source active envelope becomes the encrypted inactive record. The target record retains metadata and an active marker, not a second refreshable payload.

### I3. Exact home binding

The operation resolves `CODEX_HOME` once, canonicalizes it, and computes:

```text
home_id = SHA-256("opencodex-native-profile-home-v1\0" || canonical_home_bytes)
```

The vault, encrypted payload AAD, lock, and journal all carry this `home_id`. A mismatch is a hard error. An invalid explicit `CODEX_HOME` is never replaced with a fallback path.

The CLI displays the canonical path used for the operation. The vault may store only `home_id`; it does not need to persist the raw path.

### I4. No plaintext inactive profile

After a successful command returns, an inactive native envelope exists only as authenticated ciphertext. Temporary plaintext created for staged official login is ACL-restricted and removed before success is reported.

There is no `--allow-plaintext`, environment-variable bypass, or automatic fallback when key storage is unavailable.

### I5. Unknown reads are not transitions

Missing, malformed, and unreadable active credentials are `unknown` states. They stop the switch without changing the vault, runtime state, active profile marker, or task affinity.

### I6. Commit before runtime reset

`__main__` quota, cooldown, reauth, plan, cache, thread affinity, and WebSockets are cleared only after both the credential replacement and vault ownership transfer have committed.

### I7. Task and history preservation

No transaction step may write, move, truncate, or delete Codex task, history, rollout, session, or project files. A different account may be unable to continue a server-side task, but OpenCodex does not rewrite that task to hide the incompatibility.

## Storage model

The vault contains public metadata and authenticated ciphertext. Token-bearing fields are always inside `payload`.

```ts
type NativeMainProfileVaultV1 = {
  version: 1;
  revision: number;
  homeId: string;
  activeProfileId: string | null;
  profiles: NativeMainProfileRecordV1[];
};

type NativeMainProfileRecordV1 = {
  id: string;
  label: string;
  identityHash: string;
  identityHint: string;
  state: "active" | "inactive";
  payload: EncryptedEnvelopeV1 | null;
  createdAt: string;
  updatedAt: string;
};

type EncryptedEnvelopeV1 = {
  cipher: "aes-256-gcm";
  keyRef: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  envelopeSha256: string;
};
```

`identityHint` is a user-safe, masked value. Email and raw account IDs are not required for listing. The authenticated additional data binds the ciphertext to:

```text
format_version || home_id || profile_id || identity_hash || envelope_sha256
```

The vault and journal use `atomicWriteFileAsync()` so Windows ACL application remains asynchronous and happens before publication by rename. In this design, "published" means that the rename completed and a later OpenCodex process can observe the transaction file. `atomicWriteFileAsync()` does not `fsync` either the file or its parent directory. Version 1 therefore covers recovery after an OpenCodex process exit at a published transaction phase; it does not claim durability across an OS or kernel crash or sudden power loss.

## Key custody

The implementation needs a narrow key-provider boundary:

```ts
interface NativeProfileKeyProvider {
  getOrCreate(homeId: string): Promise<{
    keyRef: string;
    key: Uint8Array;
  }>;
}
```

Requirements:

- The production provider stores the random 256-bit master key in an OS-protected credential store.
- The vault file never contains the master key.
- A key-store failure is terminal and leaves native auth unchanged.
- Tests inject an in-memory deterministic provider.
- Decrypted buffers are short-lived and cleared on a best-effort basis.
- Crypto code uses a Bun-compatible `node:crypto` surface and is tested with both bundled Bun and Bun 1.4 canary.

The implementation candidate uses `@napi-rs/keyring` 1.3.0, a Rust N-API binding over the native platform credential stores. It is loaded only for native-profile operations and has no shell, PowerShell, environment-variable, or adjacent-file fallback. A missing native binary or unavailable key store fails closed. A random key in a neighboring ACL-only file remains an unacceptable substitute.

## Credential capability probe

Every mutating command runs the following read-only probe first:

1. Resolve and canonicalize the effective `CODEX_HOME`.
2. Resolve the installed Codex credential-store mode.
3. Accept only an explicit or default `file` result.
4. Reject `keyring`, `auto`, and `ephemeral` with a specific error and no writes.
5. Read `auth.json` once and classify it as `ok`, `missing`, `invalid`, or `unreadable`.
6. Parse the complete JSON only to validate the ChatGPT envelope and derive a stable identity.
7. Report the canonical home, store mode, active identity hint, and feature availability without returning credentials.

`auto` is rejected even when `auth.json` currently exists. Official Codex may later save to keyring and remove the file, so treating that file as authoritative would create split ownership.

## Enrollment

Two enrollment paths are needed.

### Register the current active profile

`ocx account main register <label>` associates the current native identity with a profile ID and active marker. It does not create an inactive copy that can be refreshed independently.

### Add another profile

`ocx account main add <label>` should run the installed official `codex login` against a new, restricted staging `CODEX_HOME` forced to `file` mode. After the official login exits successfully:

1. Read and validate the complete staged envelope.
2. Reject an identity already registered for the same home.
3. Encrypt the exact staged bytes into an inactive vault record.
4. Atomically publish the updated vault.
5. Remove the staging directory.
6. Report success only after no staged plaintext remains.

This keeps the current active login untouched and delegates login creation to official Codex. OpenCodex does not synthesize a native envelope from Pool credentials.

An OpenCodex process exit can leave an ACL-restricted staging directory. The next `doctor`, `add`, or `switch` command must detect it and offer deterministic cleanup without printing its contents.

## Switch transaction

The management backend, not the GUI, owns the transaction.

### Preconditions

1. The capability probe reports `file` mode and a readable ChatGPT envelope.
2. No unresolved switch journal exists.
3. The target profile is inactive, decrypts successfully, and belongs to the same `home_id`.
4. Source and target identities are known and different.
5. The OS key provider is available.
6. OpenCodex has drained new `__main__` requests.
7. No known native Codex process can refresh the source credential.

The first implementation does not expose a force-live option.

### Commit sequence

1. Acquire an interprocess lock scoped to `home_id`.
2. Re-run recovery if a journal appeared before lock acquisition.
3. Read the source raw envelope once and verify its identity and digest.
4. Decrypt and validate the target raw envelope in memory.
5. Encrypt the current source raw envelope as the future inactive source payload.
6. Atomically write a `PREPARED` journal containing encrypted source and target candidates, expected identities, expected digests, and the pre-transaction vault revision.
7. Replace `auth.json` with the exact target bytes using `atomicWriteFileAsync()` and restrictive ACLs.
8. Read back `auth.json`; require exact target digest and target identity.
9. On any failure after step 7, atomically restore the exact source bytes and verify source digest and identity.
10. Atomically mark the journal `AUTH_REPLACED`.
11. Atomically update the vault: source becomes inactive with its encrypted payload; target becomes active with `payload: null`.
12. Atomically mark the journal `VAULT_COMMITTED`, then remove it.
13. Publish a confirmed native-main transition from source identity to target identity.
14. Clear only `__main__` derived runtime state and close stale WebSockets.
15. Release the traffic drain and lock.
16. Return `restartRequired: true` for native Codex clients.

If source restoration fails, the command must retain the encrypted journal, stop all further writes, and return a manual-recovery error. It must never claim that the old login was restored.

## OpenCodex process-exit recovery state machine

The journal is encrypted where it carries auth bytes. Recovery after an interrupted OpenCodex process compares current auth digest and identity rather than trusting the last recorded phase. The phase names below describe transaction files already published by rename, not an OS- or power-loss durability boundary.

| Journal phase | Current auth observation | Recovery action |
| --- | --- | --- |
| `PREPARED` | Exact source | Restore pre-transaction vault metadata and remove journal |
| `PREPARED` | Exact target | Finish target ownership commit |
| `PREPARED` | Target identity, new digest | Treat as target refreshed externally; finish commit and warn |
| `AUTH_REPLACED` | Exact target or target identity | Finish vault commit |
| Any | Exact source or source identity | Roll back vault ownership to source |
| Any | Missing, invalid, unreadable, or third identity | Make no credential write; require explicit recovery |
| `VAULT_COMMITTED` | Target identity | Publish runtime transition if needed and remove journal |

Recovery is idempotent. Repeating it must converge on the same active owner without duplicating an inactive payload.

## Validation contract

Validation has three layers.

### Offline envelope validation

- Root must be a JSON object.
- Auth mode must represent native ChatGPT auth, including supported legacy absence of `auth_mode`.
- `tokens.id_token`, `tokens.access_token`, and `tokens.refresh_token` must be non-empty strings.
- The account identity must be derivable and internally consistent.
- JWT claims are parsed as hints, not treated as signature validation.
- Unknown fields are accepted and preserved in the raw bytes.

### Optional authority probe

If the target access token is not expired, the backend may perform the existing read-only main-account probe before writing. It must not refresh the token. A confirmed rejection aborts before `auth.json` changes.

An expired access token with a present refresh token is not refreshed by OpenCodex. The switch may proceed under the single-owner transfer, after which official Codex owns refresh. The result must state that restart and official refresh are required.

### Write validation

After replacement, the backend verifies exact raw digest and confirmed target identity. Any mismatch triggers exact source restoration and restoration verification.

This gives the first PR a testable guarantee: failed preflight leaves the original untouched, and failed publication restores the original before returning.

## Runtime reconciliation

The existing external-identity reconciliation remains necessary for logins changed outside OpenCodex. A managed switch should additionally publish an explicit confirmed transition event:

```ts
applyConfirmedMainAccountTransition({
  fromAccountId,
  toAccountId,
  source: "native-profile-switch",
});
```

That event should call the same internal reset primitive used by external reconciliation. It must clear only:

- `__main__` usage and plan cache
- `__main__` quota and cooldown state
- `__main__` reauth state
- `__main__` thread affinity
- stale main-account WebSockets

It must not clear task/history data, Pool credentials, Pool account state, provider credentials, or unrelated account caches.

Existing request-generation fencing should continue to prevent an old in-flight response from publishing state after the confirmed transition.

## Native Codex restart semantics

OpenCodex can drain its own main-account requests, but it cannot acquire the internal refresh lock of another native Codex process.

For v1:

- Detect known Codex desktop, CLI, and app-server processes on a best-effort basis.
- Refuse a switch while such a process is active.
- Do not terminate user processes automatically.
- Return an explicit restart requirement after success.
- Keep `--restart` orchestration out of the first PR.

This is stricter than allowing existing work to continue, but it closes the rotating-refresh-token race. OpenCodex requests that were already in flight before the drain may finish with their captured identity; their stale state publication remains fenced.

## CLI contract

Proposed first-version commands:

```text
ocx account main doctor [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main list [--json]
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

Output rules:

- Always show the effective canonical `CODEX_HOME` for mutating commands.
- Show profile IDs, user labels, active/inactive state, and masked identity hints.
- Never show raw account IDs, email unless explicitly opted in, token fragments, digests derived directly from tokens, decrypted paths, or auth JSON.
- JSON errors use stable codes such as `UNSUPPORTED_AUTH_STORE`, `CODEX_HOME_MISMATCH`, `CODEX_BUSY`, `AUTH_UNKNOWN`, `PROFILE_DECRYPT_FAILED`, `AUTH_RESTORE_FAILED`, and `RECOVERY_REQUIRED`.
- `switch` reports whether online probing was performed and whether official refresh is expected after restart, without exposing the reason body from an auth server.

The existing `ocx account use` command remains Pool selection. Native profile commands live under `ocx account main` so the two concepts cannot be confused.

## Management boundary

The running service should perform the switch because it owns the `__main__` request drain and runtime reconciliation. The CLI sends only a profile ID and operation options through an authenticated local management route. Decrypted envelopes never cross the management API.

If the service is unavailable, read-only `doctor` and `list` may work locally. A mutating `switch` should fail closed rather than changing auth without draining and reconciling the running service.

## Required test matrix

All focused tests run once with the repository's bundled Bun and once with Bun 1.4 canary.

### Envelope fidelity

- Preserve unknown top-level and nested fields byte-for-byte.
- Preserve whitespace and field order in a restored original.
- Reject incomplete ChatGPT token data without writing.
- Reject Pool credential records as native envelopes.
- Keep token values out of thrown errors, logs, snapshots, and JSON output.

### Home and store mode

- Bind records to the canonical effective home.
- Reject an invalid explicit home without fallback.
- Reject home hash mismatch before decryption/write.
- Reject `keyring`, `auto`, and `ephemeral` without writes.
- Accept absent store configuration as official default `file` only when no higher-precedence override is active.

### Transaction and rollback

- Target decrypt failure leaves source and vault unchanged.
- Target validation failure leaves source and vault unchanged.
- Temporary write failure leaves source unchanged.
- ACL failure leaves source unchanged and removes residual temp files.
- Rename/read-back mismatch restores the exact source bytes.
- Restore verification failure retains the encrypted journal and reports `AUTH_RESTORE_FAILED`.
- Vault commit failure after auth replacement is recovered deterministically.
- Every injected OpenCodex hard-exit point after a published transaction phase converges correctly when recovery is repeated.
- A third identity or unreadable auth during recovery causes no write.

### Refresh ownership and concurrency

- Active records never retain an inactive payload after commit.
- Inactive records are never passed to the Pool refresh path.
- Concurrent switches serialize on `home_id`.
- Native Codex busy detection prevents mutation.
- New `__main__` requests are drained during commit.
- An old in-flight response cannot publish usage/plan data after transition.

### Runtime and data preservation

- Successful identity change clears only documented `__main__` derived state.
- Unknown reads and same-identity token changes do not clear state.
- Task and history fixture trees are byte-identical before and after switch and rollback.
- Pool, OAuth, provider, and API-key stores are byte-identical.
- Switch-back uses the same transaction and restores the previous profile as a normal target.

## PR boundary

This design document is not itself a request to merge credential handling.

The first behavior-changing PR should include:

- CLI/backend only, no dashboard UI.
- File-mode capability probe and explicit unsupported-mode errors.
- Full-fidelity opaque envelope handling.
- OS-protected key-provider implementation with no plaintext fallback.
- Encrypted inactive-profile vault.
- Home-scoped lock and encrypted switch journal for OpenCodex process-exit recovery.
- Rename-published switch phases, exact read-back, exact restore, and recovery within the documented v1 scope.
- Confirmed `__main__` runtime transition integration.
- Failure-injection tests proving original-login restoration.
- Bundled Bun and Bun 1.4 canary focused test results.

A smaller read-only `doctor` PR can precede it only if maintainers want the credential-mode diagnostics separately. No PR should add a partial write path that lacks rollback proof.

## Implementation choices proposed by the PR

The PR makes the recommended choices concrete instead of blocking on a separate policy round:

1. Use `@napi-rs/keyring` as the OS-protected master-key provider and fail closed without it.
2. Support file-mode Codex credentials only in v1; reject `keyring`, `auto`, and `ephemeral` before writes.
3. Transfer an expired target envelope without refreshing it in OpenCodex; official Codex owns refresh after restart.
4. Detect native Codex processes best-effort, never terminate them, and require explicit stopped confirmation when detection is unavailable.
5. Invoke official `codex login` in an ACL-restricted staging home and remove its plaintext envelope before reporting success.

These are reviewable implementation decisions, not claims of governance authority. Maintainers can accept, narrow, or replace them against working code and failure-injection evidence.
