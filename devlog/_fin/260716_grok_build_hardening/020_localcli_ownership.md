# 020 — `local-cli` xAI credential ownership handoff

## Work-phase contract

- Work-phase: `wp2_localcli_ownership`
- Class: C4 (OAuth rotating-refresh ownership); implementation is limited to the xAI credential path and its regression tests.
- Goal: while an xAI credential is tagged `source: "local-cli"`, treat `~/.grok/auth.json` as the authority and adopt a newer disk generation before any IdP refresh.
- Dependency: none. Phase 030 may add OpenCodex-store cross-process serialization after this ownership rule exists.

## Threat / failure contract

| Item | Contract |
|---|---|
| Asset | xAI access token, rotating refresh token, and continued Grok account session |
| Entrypoints | login-time local import and request/guardian-driven refresh |
| Trust boundary | Grok Build-owned `~/.grok/auth.json` → OpenCodex-owned `~/.opencodex/auth.json` → xAI token endpoint |
| Failure | Grok CLI and OpenCodex independently spend the same refresh generation; one receives `invalid_grant`, or the last persisted stale generation forces re-login |
| Official invariant | one `AuthManager` owns a store and holds `auth.json.lock` across the IdP exchange; a follower adopts the rotated disk token instead of calling the IdP (`/Users/jun/Developer/codex/180_grok-build/crates/codegen/xai-grok-shell/src/auth/manager.rs:64-68,1529-1561,1604-1642`) |
| Contract proof | two managers sharing one store produce exactly one IdP call (`/Users/jun/Developer/codex/180_grok-build/crates/codegen/xai-grok-shell/src/auth/refresh/auth_backend_contract_tests.rs:351-388`) |

## Ownership decision

Choose **adopt while attached; explicit detach on unavoidable stale refresh**.

1. A credential remains attached only while its persisted source is `"local-cli"`.
2. Before either login-time refresh or normal refresh, re-read `~/.grok/auth.json`.
3. If the Grok credential is authoritative under the monotonic expiry rule below and its access token is usable, persist/adopt it in OpenCodex and make **zero** discovery/token-endpoint calls.
4. If Grok is also stale and OpenCodex must refresh to serve the request, call the IdP once with the currently selected Grok refresh token, persist the successor only to OpenCodex with `source: "oauth"`, and emit a one-time-per-refresh warning that this account has detached from Grok CLI ownership. Subsequent OpenCodex refreshes do not consult Grok storage.
5. Never write `~/.grok/auth.json` from OpenCodex.

Rationale: writing the successor into another application's store would need exact format preservation, permission preservation, atomic replacement, and interoperability with Grok's `auth.json.lock`. OpenCodex does not own that lock protocol, so even an atomic JSON rewrite could race Grok and corrupt or roll back unrelated fields. Detaching gives the rotated successor one durable owner after the exchange and preserves the official single-owner shape. The residual race is the **first detach exchange** if Grok refreshes concurrently; phase 020 reduces the common stale-copy race but cannot claim cross-application mutual exclusion. Phase 030's OpenCodex lock does not by itself coordinate with Grok's lock and must not be described as doing so.

The warning text is fixed for testability and must not contain token material:

```text
[oauth:xai] Grok CLI credential was stale; refreshed into OpenCodex ownership. Grok CLI may require login again.
```

## Generation and identity rules

`detectGrokCliToken()` remains a fresh read on every invocation. A detected credential is eligible only when it is the same identity as the stored OpenCodex account:

- if both sides have `accountId`, they must match;
- otherwise, if both sides have `email`, compare lower-cased values;
- if neither comparable identity exists, allow adoption only for the active xAI account whose stored source is `"local-cli"` (the original import relationship is the binding).

Generation authority is monotonic and is based on fixed token lifetime, not refresh-token inequality: a later `expires` means later issuance and therefore a later generation. Adopt disk only when its access token is currently usable (`disk.expires > Date.now() + REFRESH_SKEW_MS`) and either (a) both expiries exist and disk expires later, or (b) the expiries tie or either expiry is missing. The tie/missing case deliberately prefers the Grok-owned copy only while its access token proves usable. If disk has an earlier expiry, keep the OpenCodex generation even when the refresh strings differ. A merely different refresh token is never evidence of newness and is never selected as refresh input by itself; when disk is stale, older, or ineligible, refresh the stored OpenCodex generation.

## IN / OUT

### IN

- xAI `source: "local-cli"` reconciliation at login and normal account refresh.
- Identity-safe generation comparison.
- Detach metadata and redacted warning when an IdP refresh is still required.
- Temp-HOME regression coverage, including zero endpoint calls for newer-generation adoption.

### OUT

- Writing, locking, chmod-ing, backing up, or otherwise mutating `~/.grok/auth.json`.
- Implementing Grok's Rust file-lock protocol or claiming cross-app locking.
- Generic local-CLI ownership changes for Anthropic or Kiro.
- New config keys, GUI controls, or CLI flags.
- Phase 030 OpenCodex-store locking, phase 040 401 replay, production code changes outside the file map below.

## Config decision

No config surface is added.

- `LocalTokenImportMode = "off" | "fallback" | "only"` is an internal flow type, not an `OcxConfig` field (`src/oauth/types.ts:38-43`).
- xAI login currently maps `forceLogin: true` to `importLocal: "off"`; otherwise it uses `"fallback"` (`src/oauth/index.ts:21,49-55`).
- `runLogin()` persists the flow's source and defaults source-less browser credentials to `"oauth"` (`src/oauth/index.ts:349-359`).
- Preserve that wiring: `forceLogin` remains the explicit browser-login/detach path. Do not expose `importLocal` in `src/config.ts`.

## File change map

| Marker | Path | Required diff |
|---|---|---|
| MODIFY | `src/oauth/local-token-detect.ts` | Extract/export identity and generation comparison helpers beside `detectGrokCliToken()`; retain read-only semantics and fresh HOME-based reads. |
| MODIFY | `src/oauth/xai.ts` | Reconcile the local store before login-time refresh; detach stale local credentials after successful IdP refresh; expose the ownership warning constant/helper needed by the account refresh path. |
| MODIFY | `src/oauth/index.ts` | Before refreshing an expired xAI `source:"local-cli"` account, re-read Grok credentials, identity-check, adopt a usable expiry-authoritative disk generation with zero IdP calls, or refresh the stored OpenCodex generation and persist the successor as `source:"oauth"`. |
| MODIFY | `tests/oauth-refresh.test.ts` | Add temp-HOME Grok fixture and request classification counters; cover normal refresh adoption, unchanged/stale detach, identity mismatch, and persistence. |
| NEW | none | Reuse the existing OAuth refresh suite and modules; do not create a parallel ownership service or config schema. |

`src/oauth/store.ts` is inspected but unchanged: it already allowlists `source`, preserves account IDs, and provides account-scoped persistence (`src/oauth/store.ts:62-84,230-248`).

## Diff-level design

### MODIFY — `src/oauth/local-token-detect.ts`

Current (complete relevant imports and implementation):

```ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    return {
      refresh: entry.refresh_token as string,
      access: entry.key as string,
      expires: entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}
```

After (the existing Claude detector code below this block remains byte-for-byte unchanged, so its `execSync` import remains required):

```ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;
    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    return {
      refresh: entry.refresh_token as string,
      access: entry.key as string,
      expires: entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

export function hasComparableGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  return Boolean((stored.accountId && disk.accountId) || (stored.email && disk.email));
}

export function isSameGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  if (stored.accountId && disk.accountId) return stored.accountId === disk.accountId;
  if (stored.email && disk.email) return stored.email.toLowerCase() === disk.email.toLowerCase();
  return false;
}

export function shouldAdoptGrokGeneration(
  stored: OAuthCredentials,
  disk: OAuthCredentials,
  now = Date.now(),
  refreshSkewMs = 60_000,
): boolean {
  if (disk.expires <= now + refreshSkewMs) return false;
  const bothExpiriesExist = stored.expires > 0 && disk.expires > 0;
  if (bothExpiriesExist) return disk.expires >= stored.expires;
  return true;
}
```

`accountId` and `email` are the only shared identity fields: Grok maps `user_id`/`email` into them and `OAuthCredentials` defines no other account identity. `hasComparableGrokIdentity()` is therefore exact, exported, and false unless at least one field exists on both sides. The no-comparable-identity fallback is accepted only by the active-account gate in `index.ts`; `isSameGrokIdentity()` alone never authorizes it. `shouldAdoptGrokGeneration()` intentionally does not inspect `refresh`.

### MODIFY — `src/oauth/xai.ts`

Current (complete imports and `loginXai` implementation):

```ts
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";

export async function loginXai(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode },
): Promise<OAuthCredentials> {
  const importLocal = opts?.importLocal ?? "off";
  if (importLocal !== "off") {
    const { detectGrokCliToken } = await import("./local-token-detect");
    const local = detectGrokCliToken();
    if (local) {
      ctrl.onProgress?.("Found Grok CLI token, importing automatically");
      if (local.expires >= Date.now() + 60_000) return local;
      try {
        return { ...(await refreshXaiToken(local.refresh, ctrl.signal)), source: "local-cli" };
      } catch (error) {
        if (importLocal === "only") {
          throw new Error(
            `Grok CLI token is expired and could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else if (importLocal === "only") {
      throw new Error("No Grok CLI token found at ~/.grok/auth.json. Run 'ocx login xai' for browser OAuth.");
    }
  }

  return new XaiOAuthFlow(ctrl).login();
}
```

After (complete imports and implementation):

```ts
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";

export const XAI_LOCAL_CLI_DETACH_WARNING =
  "[oauth:xai] Grok CLI credential was stale; refreshed into OpenCodex ownership. Grok CLI may require login again.";

export async function loginXai(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode },
): Promise<OAuthCredentials> {
  const importLocal = opts?.importLocal ?? "off";
  if (importLocal !== "off") {
    const { detectGrokCliToken } = await import("./local-token-detect");
    const local = detectGrokCliToken();
    if (local) {
      ctrl.onProgress?.("Found Grok CLI token, importing automatically");
      if (local.expires >= Date.now() + 60_000) return local;
      try {
        const fresh = await refreshXaiToken(local.refresh, ctrl.signal);
        ctrl.onProgress?.(XAI_LOCAL_CLI_DETACH_WARNING);
        return { ...fresh, source: "oauth" };
      } catch (error) {
        if (importLocal === "only") {
          throw new Error(
            `Grok CLI token is expired and could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else if (importLocal === "only") {
      throw new Error("No Grok CLI token found at ~/.grok/auth.json. Run 'ocx login xai' for browser OAuth.");
    }
  }

  return new XaiOAuthFlow(ctrl).login();
}
```

This login branch already reads Grok immediately before deciding to refresh, so no second redundant read is required inside `refreshXaiToken()`. Keep `refreshXaiToken()` provider-pure; ownership depends on credential source/account context and does not belong in the raw token endpoint client.

### MODIFY — `src/oauth/index.ts`

Current (complete imports and `refreshAndPersistAccessToken`; preserved verbatim from the current source):

```ts
import type { OAuthController, OAuthCredentials } from "./types";
import { getAccountCredential, getAccountSet, saveAccountCredential, saveCredential, markAccountNeedsReauth, getCredential } from "./store";
import { loginXai, refreshXaiToken } from "./xai";
import { loginKiro, readKiroCliSqlite, refreshKiroToken } from "./kiro";

async function refreshAndPersistAccessToken(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  cred: OAuthCredentials,
): Promise<string> {
  // Local-CLI import fallback only for the ACTIVE account: importing another identity's
  // token under a background account id would silently contaminate that account.
  const isActive = getAccountSet(provider)?.activeAccountId === accountId;
  if (provider === "kiro" && isActive) {
    const imported = readFreshKiroCliCredential();
    if (imported) {
      saveCredential(provider, imported);
      return imported.access;
    }
  }
  try {
    const fresh = await def.refresh(cred.refresh);
    // Persist to THIS account (rotation-safe: new refresh token hits disk before use) without
    // touching activeAccountId.
    saveAccountCredential(provider, accountId, {
      ...fresh,
      source: fresh.source ?? cred.source ?? "oauth",
      // Preserve a previously-discovered project id when a refresh-time re-discovery comes back empty
      // (e.g. a transient network blip), so Antigravity does not lose its CCA project across refresh.
      ...(fresh.projectId === undefined && cred.projectId ? { projectId: cred.projectId } : {}),
      // Preserve identity fields the refresh response may omit, so identity matching stays stable.
      ...(fresh.email === undefined && cred.email ? { email: cred.email } : {}),
      ...(fresh.accountId === undefined && cred.accountId ? { accountId: cred.accountId } : {}),
    });
    return fresh.access;
  } catch (err) {
    if (provider === "kiro" && isActive) {
      const imported = readFreshKiroCliCredential();
      if (imported) {
        saveCredential(provider, imported);
        return imported.access;
      }
    }
    if (isTerminalRefreshError(err)) {
      markAccountNeedsReauth(provider, accountId, true);
      throw new OAuthLoginRequiredError(provider);
    }
    throw err;
  }
}
```

After (complete imports and implementation; the Kiro, terminal-error, and fallback-field branches remain explicit):

```ts
import type { OAuthController, OAuthCredentials } from "./types";
import { getAccountCredential, getAccountSet, saveAccountCredential, saveCredential, markAccountNeedsReauth, getCredential } from "./store";
import { loginXai, refreshXaiToken, XAI_LOCAL_CLI_DETACH_WARNING } from "./xai";
import { loginKiro, readKiroCliSqlite, refreshKiroToken } from "./kiro";
import { detectGrokCliToken, hasComparableGrokIdentity, isSameGrokIdentity, shouldAdoptGrokGeneration } from "./local-token-detect";

async function refreshAndPersistAccessToken(
  provider: string,
  accountId: string,
  def: OAuthProviderDef,
  cred: OAuthCredentials,
): Promise<string> {
  // Local-CLI import fallback only for the ACTIVE account: importing another identity's
  // token under a background account id would silently contaminate that account.
  const isActive = getAccountSet(provider)?.activeAccountId === accountId;
  if (provider === "kiro" && isActive) {
    const imported = readFreshKiroCliCredential();
    if (imported) {
      saveCredential(provider, imported);
      return imported.access;
    }
  }
  if (provider === "xai" && cred.source === "local-cli") {
    const disk = detectGrokCliToken();
    const identityMatches = disk !== null && isSameGrokIdentity(cred, disk);
    const noIdentityActiveBinding =
      disk !== null && isActive && !hasComparableGrokIdentity(cred, disk);
    if (
      disk !== null &&
      (identityMatches || noIdentityActiveBinding) &&
      shouldAdoptGrokGeneration(cred, disk, Date.now(), REFRESH_SKEW_MS)
    ) {
      saveAccountCredential(provider, accountId, disk);
      return disk.access;
    }
  }
  try {
    const fresh = await def.refresh(cred.refresh);
    const detachedLocalCli = provider === "xai" && cred.source === "local-cli";
    if (detachedLocalCli) console.warn(XAI_LOCAL_CLI_DETACH_WARNING);
    // Persist to THIS account (rotation-safe: new refresh token hits disk before use) without
    // touching activeAccountId.
    saveAccountCredential(provider, accountId, {
      ...fresh,
      source: detachedLocalCli ? "oauth" : fresh.source ?? cred.source ?? "oauth",
      // Preserve a previously-discovered project id when a refresh-time re-discovery comes back empty
      // (e.g. a transient network blip), so Antigravity does not lose its CCA project across refresh.
      ...(fresh.projectId === undefined && cred.projectId ? { projectId: cred.projectId } : {}),
      // Preserve identity fields the refresh response may omit, so identity matching stays stable.
      ...(fresh.email === undefined && cred.email ? { email: cred.email } : {}),
      ...(fresh.accountId === undefined && cred.accountId ? { accountId: cred.accountId } : {}),
    });
    return fresh.access;
  } catch (err) {
    if (provider === "kiro" && isActive) {
      const imported = readFreshKiroCliCredential();
      if (imported) {
        saveCredential(provider, imported);
        return imported.access;
      }
    }
    if (isTerminalRefreshError(err)) {
      markAccountNeedsReauth(provider, accountId, true);
      throw new OAuthLoginRequiredError(provider);
    }
    throw err;
  }
}
```

Required details:

- Import the detector/comparison helpers statically; they perform no I/O until called.
- Keep the existing `(provider, accountId)` singleflight around the whole reconciliation + refresh path (`src/oauth/index.ts:156-169`).
- Persist adoption with `saveAccountCredential`, not `saveCredential`, so the active account is not switched.
- Preserve existing Kiro pre-refresh and post-failure recovery branches unchanged.
- On a terminal failure, keep `markAccountNeedsReauth()` behavior. Do not retag to `"oauth"` unless an IdP refresh succeeded and its successor was persisted.
- Never log access/refresh tokens, raw Grok JSON, email, or account ID.

### MODIFY — `tests/oauth-refresh.test.ts`

Add a fixture matching the real Grok JSON carrier:

```ts
function seedGrokAuth(token: {
  key: string;
  refresh_token: string;
  expires_at: string;
  user_id?: string;
  email?: string;
}) {
  const dir = join(tmp, ".grok");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ "https://auth.x.ai::test": token }),
  );
}
```

Extend the fetch mock to count discovery separately from token POSTs; acceptance is specifically zero token-endpoint calls and should also assert zero total network calls for adoption.

Exact test names:

1. `newer Grok generation is adopted before xAI refresh with zero endpoint calls`
   - persist expired xAI `source:"local-cli"`, generation `rt-old`, identity `user-1`;
   - seed temp `HOME/.grok/auth.json` with fresh `rt-new`, same identity;
   - call `getValidAccessToken("xai")`;
   - assert returned access is the Grok value, fetch count is `0`, stored refresh is `rt-new`, source remains `local-cli`.
2. `newer-expiry Grok access token is adopted when refresh generation is unchanged`
   - same refresh token, later usable expiry;
   - assert zero fetches and updated access/expiry persistence.
3. `stale Grok generation refreshes once and detaches to OpenCodex ownership`
   - both stores carry the same expired generation;
   - mock one discovery GET plus one token POST returning rotated credentials;
   - spy on `console.warn`;
   - assert exactly one token POST, warning text, successor persisted with `source:"oauth"`, and Grok file bytes remain unchanged.
4. `stale different Grok generation with earlier expiry is not adopted`
   - OpenCodex has expired `rt-ours`; Grok has different `rt-disk` with an earlier expiry;
   - inspect the normal refresh token POST body and assert `refresh_token=rt-ours`, never `rt-disk`;
   - assert no adoption write occurs before refresh, exactly one normal discovery GET plus one token POST occurs, and the successor source is `oauth`.
5. `mismatched Grok identity is not adopted into a local-cli account`
   - stored `user-1`, disk `user-2` with a fresh token;
   - assert disk access is not returned or persisted; the stored generation is used for detach refresh, then source becomes `oauth`.
6. `concurrent xAI local-cli refreshes share reconciliation and one detach exchange`
   - two calls for the same account;
   - assert the existing singleflight produces one token POST and both callers receive the same access token.

Test hygiene: restore `console.warn`, `fetch`, `HOME`, and `OPENCODEX_HOME` in `afterEach`; delete the temp tree. No live xAI traffic.

## Acceptance criteria and activation scenarios

| ID | Criterion | Activation scenario | Required proof |
|---|---|---|---|
| AC-020-1 | Every normal refresh of xAI `source:"local-cli"` re-reads Grok storage before IdP exchange. | Expired OpenCodex generation; temp-HOME Grok file replaced with a fresh different refresh token after OpenCodex persistence. | Returned/stored Grok token; zero fetch calls. |
| AC-020-2 | Same refresh generation with a newer usable expiry is adopted. | OpenCodex stale expiry, Grok later expiry. | Zero fetch calls; access and expiry updated. |
| AC-020-3 | Refresh-token inequality alone never changes authority. | Grok refresh differs but its expiry is earlier than the stored OpenCodex expiry. | Disk is not adopted; the normal refresh spends the stored OpenCodex refresh token; no unnecessary IdP calls beyond that one discovery GET and one token POST. |
| AC-020-4 | Successful stale refresh detaches ownership. | Both stores stale and one mocked IdP exchange succeeds. | OpenCodex source becomes `oauth`; warning emitted; Grok bytes unchanged. |
| AC-020-5 | Identity mismatch cannot contaminate an account. | Fresh Grok token belongs to a different `user_id`. | No adoption; stored account ID remains unchanged. |
| AC-020-6 | Existing login controls retain semantics. | default login with usable Grok token; `forceLogin:true`; stale fallback; `importLocal:"only"`. | default imports, force login skips, stale successful refresh returns `source:"oauth"`, only-mode preserves failure contract. |
| AC-020-7 | Existing account singleflight remains intact. | Two simultaneous calls for one expired xAI account. | One detach token POST; identical access result. |
| AC-020-8 | No external-store mutation is introduced. | Snapshot Grok file before stale refresh. | Byte-identical after success and failure; no `.lock`, backup, or temp sibling created by OpenCodex. |

## Risk / rollback

- **Rollback unit:** revert the single phase-020 implementation commit with `git revert <phase-020-commit>`. Do not hand-edit credential files and do not revert sibling phase commits as part of this rollback.
- **Persisted state:** credentials already detached by a successful refresh remain valid when tagged `source:"oauth"`; the tag accurately says OpenCodex owns the newly issued rotating refresh generation, and rollback must not relabel it `local-cli` or copy it back to Grok. Credentials adopted from disk and still tagged `local-cli` also remain ordinary valid OAuth credentials; after rollback they retain the pre-phase behavior until their next refresh.
- **`needsReauth`:** phase 020 preserves the existing rule that only terminal refresh failures set `needsReauth`. Reverting code does not clear an already-set marker and must not do so automatically: the underlying grant may actually be revoked or reused. A detached credential whose refresh succeeded is persisted without setting `needsReauth`; rollback leaves that successful credential usable.
- **Rollback verification:** run the focused OAuth refresh suite and typecheck after the revert; inspect `~/.opencodex/auth.json` only through redacted status/test fixtures to confirm detached entries remain `source:"oauth"`; verify a detached xAI credential refreshes without reading `~/.grok/auth.json`; verify an account already marked `needsReauth` still requires login; and confirm `~/.grok/auth.json` bytes are unchanged.

## Verification commands

Run from `/Users/jun/Developer/new/700_projects/opencodex`:

```bash
bun test --isolate ./tests/oauth-refresh.test.ts
bun test --isolate ./tests/oauth-manual-code.test.ts ./tests/oauth-store-multi.test.ts ./tests/token-guardian.test.ts
bun run typecheck
bun run test
bun run privacy:scan
git diff --check -- src/oauth/local-token-detect.ts src/oauth/xai.ts src/oauth/index.ts tests/oauth-refresh.test.ts
```

The commands follow `package.json` scripts: `test = bun test --isolate ./tests/`, `typecheck = bun x tsc --noEmit`, and `privacy:scan = bun scripts/privacy-scan.ts` (`package.json:38-48`). The focused OAuth suite must run before the full suite. No live login or production proxy restart is required for this ownership-only phase.

## Implementing-cycle stale-check checklist

- [ ] Re-read current `src/oauth/local-token-detect.ts`, `src/oauth/xai.ts`, `src/oauth/index.ts`, `src/oauth/store.ts`, and `src/oauth/types.ts`; update line anchors if they moved.
- [ ] Re-run `rg -n "importLocal|forceLogin|local-cli|refreshXaiToken|detectGrokCliToken" src tests` and confirm no new owner/config surface appeared.
- [ ] Re-read official `manager.rs` lock/adoption sections and `auth_backend_contract_two_instances_share_one_idp_call`; record any changed paths or semantics.
- [ ] Inspect sibling phase 030 before implementation; keep cross-process locking out of phase 020 and do not duplicate its helpers.
- [ ] Confirm other workers did not modify `tests/oauth-refresh.test.ts` or the three production targets; preserve concurrent changes and rebase the diff-level design if needed.
- [ ] Confirm the real Grok JSON key/value fields still match `https://auth.x.ai::`, `key`, `refresh_token`, `expires_at`, `user_id`, and `email`.
- [ ] Confirm `OAuthCredentials` still exposes only `accountId` and `email` as comparable identity fields, and that `hasComparableGrokIdentity()` is exported and used by the active-account fallback gate.
- [ ] Confirm generation authority remains expiry-monotonic: later disk expiry wins; tie/missing expiry chooses disk only when disk access is usable; refresh-token inequality never establishes newness.
- [ ] Run the stale-different-generation regression: disk has a different refresh token and earlier expiry; assert no adoption, refresh body uses the stored OpenCodex token, and there are zero extra IdP calls beyond the normal one discovery GET plus one token POST.
- [ ] Confirm no implementation writes under `~/.grok`, and that warning output is redacted.
- [ ] Rehearse rollback with a temporary branch/fixture: revert only the phase commit, retain detached `source:"oauth"` and `needsReauth` state, run focused tests/typecheck, and verify Grok bytes remain unchanged.
- [ ] Execute every verification command above on the final implementation HEAD and attach exit status/test counts to phase evidence.

## Implementation record (B)

- Implemented the audited local-CLI reconciliation, identity/generation helpers, successful-refresh detach warning/source transition, and six temp-HOME regressions in the phase file map.
- Deviation: `detectGrokCliToken()` resolves `process.env.HOME` before `homedir()` so each invocation observes temp-HOME fixtures (and runtime HOME changes); the Grok store remains strictly read-only. No other design deviation.
- Verification: focused OAuth refresh suite `11 pass, 0 fail`; full suite `2602 pass, 0 fail`; `bun run typecheck` exited 0.
