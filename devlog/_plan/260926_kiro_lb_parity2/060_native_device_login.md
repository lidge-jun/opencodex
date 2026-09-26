# 060 — Native Kiro device login

- **Layer / branch:** 060, `codex/kiro-lb2-060-device-login` (two commits: Builder ID, then social).
- **Depends on:** 010's `resolveKiroRequestProfile()` contract and the preceding 050 stack head; 060 introduces no dependency on 040/050 selection.
- **Adopted inventory rows:** A1/A2/A9 in `001_research_gap_inventory.md`.
- **Architect decisions:** D060-1/2/3 accepted: server-owned flow, approval-only commit, Builder ID service profile never stored as identity. D060 split rejected; keep one PR with separate Builder ID and social test gates. The additional 060 acceptance gates in `000_plan.md` govern both commits.
- **Baseline:** opencodex `bb3f3c2d0d`. Re-read every hunk at the 050 head before applying. Reference facts below come from AGPL kiro-lb `bee73b3`; implement independently, without copying code or structure. No live endpoint has been called.

## Current state (all anchors at `bb3f3c2d0d`)

| Function / owner | Current contract and consequence |
| --- | --- |
| `loginKiro`, `src/oauth/kiro.ts:347-401` | `forceLogin` backs up and logs out the local `kiro-cli`, launches its login, imports the changed SQLite credential, then restores the former CLI session. This is the existing add path, so native add must bypass it entirely. |
| `oauthCredentialFromImported`, `src/oauth/kiro.ts:281-321` | Same-session CLI `whoami` can supply email/profile identity; a token/session race clears that identity. Native flow cannot treat the currently active CLI identity as its own. |
| `accountScopedProfileArn`, `src/oauth/kiro.ts:176-190` | The parser admits a real account profile and rejects the fixed Builder ID service profile. Export this parser for native social identity validation. |
| `resolveKiroRequestProfile`, `src/oauth/kiro.ts:520-530`; `kiroUsageContextForAccount`, `src/providers/kiro-usage.ts:214-230` at merged #5937 `9c7c046520` | The request-only Builder ID fallback is derived from `authType`; it stays out of `auth.json`, account ID, and reauth comparison. The usage probe carries `builderIdFallback` from the same resolver. Layer 050 exports `kiroManagementHost(ctx)` from `kiro-usage.ts` so a fixed Builder service ARN cannot select the management region. 060 does not construct usage hosts. |
| `refreshAwsSsoOidcToken`, `src/oauth/kiro.ts:573-612` | Stored client ID/secret plus region are already consumed for Builder ID refresh; the social refresh is `src/oauth/kiro.ts:561-570`. Native credentials must use this existing shape. |
| `normalizeCredential`, `src/oauth/store.ts:508-553` | `auth.json` accepts `kiro.clientId`, `clientSecret`, regions and profile; `authType` is derived later, rather than persisted. `OAuthCredentials` and `KiroOAuthMetadata` are defined at `src/oauth/types.ts:14-25,57-75`. |
| `mutateStore`, `src/oauth/store.ts:768-809` | Serializes the protected auth store under a file lock. Its `finalizeResult` callback at `:801-804` sees the selection revision after bookkeeping at `:782-800` and before persist; use that revision in the 060 rollback receipt. `saveCredentialWithReceipt` selects the newly saved account (`:834-913`), so it is unsuitable for native add. `saveAccountCredential` changes one existing slot without identity checking (`:1064-1078`), so it is unsuitable for native reauth. |
| `runLogin`, `src/oauth/index.ts:1603-1705`; `startLoginFlow`, `src/oauth/index.ts:1832-1915` | The generic login invokes provider login and writes the credential, with a provider-wide pending slot. Native Kiro must not call `runLogin` or share that unbound completion state. `getLoginStatus` builds an allowlisted response without Kiro secrets (`src/oauth/index.ts:1767-1799`). `upsertOAuthProvider` owns login config publication (`src/oauth/index.ts:1533-1554`). |
| `handleOauthAccountRoutes`, `src/server/management/oauth-account-routes.ts:218-279,281-316` | `/api/oauth/login` starts the generic flow, `/cancel` cancels by provider, and `/status` reports provider-wide state; extend these routes only for `provider === "kiro"` and an explicit native flow ID. The route is reached behind the management admission boundary (`src/server/management-api.ts:325`). |
| CLI `login`, `src/cli/account-auth.ts:124-245` | `ocx account login kiro` posts `addAccount: true` and polls provider-wide `/api/oauth/status`; `--id` requires `--reauth`. Add `--method builder-id|google|github` and flow-specific polling/cancel while preserving other providers. The public usage is at `src/cli/account-auth.ts:36-52`. |
| GUI `cancelOAuthLogin` / `afterOAuthCancellation`, `gui/src/oauth-cancellation-barrier.ts:1-40` | Cancellation and its delivery barrier are keyed only by provider today. Native Kiro cancellation must carry its exact flow ID while the barrier still orders all starts for that provider. |
| GUI `loginOAuth`, `gui/src/pages/use-providers-oauth.ts:91-155` and `useAddProviderOAuth`, `gui/src/components/use-add-provider-oauth.ts:91-150` | Both Kiro buttons currently POST generic `/api/oauth/login` and poll provider-wide status. Kiro's existing Add account UI therefore **must change** to pass a native method and poll the returned flow ID; the URL/code display itself already exists. The auth panel Add account button is `gui/src/components/provider-workspace/ProviderAuthPanel.tsx:624-629`. |

Reference wire facts: Kiro social host `https://prod.us-east-1.auth.desktop.kiro.dev`, client ID `kiro-cli`, `POST /oauth/device/authorization` with `{clientId,loginProvider}` and `POST /oauth/device/poll` with `{clientId,deviceCode}` (`/tmp/kiro-lb/kiro/device_login.py:35-38,119-139,162-194`). Social timings are milliseconds; HTTP 200 `status: authorization_pending` is pending; an approved body carries `accessToken`, `refreshToken`, `profileArn`, `expiresIn` (`:127-139,175-193`). Builder ID uses `https://oidc.us-east-1.amazonaws.com`: `POST /client/register` with `clientName: kiro-cli`, `clientType: public`, scopes `codewhisperer:completions`, `codewhisperer:analysis`, `codewhisperer:conversations`; `POST /device_authorization` with client ID/secret and `startUrl: https://view.awsapps.com/start`; `POST /token` with client ID/secret, device code, and device-code grant type (`:40-47,197-215,218-252,256-267`). Builder timings are seconds. Pending is HTTP 400 `authorization_pending`; `slow_down` adds five seconds; `expired_token` is terminal (`:234-236,269-284`). Builder approval carries no account profile (`:286-296`). Error-code spelling may also come from `x-amzn-errortype` (`:211-214`). These are reference observations, not a live contract guarantee: accept only narrow shapes and make unknown ones fail without persistence.

## File change map

`NEW src/oauth/kiro-device-login.ts` — server-owned state machine. Complete implementation skeleton (helpers are private; no reference code copied):

```ts
import { randomUUID } from "node:crypto";
import type { OAuthCredentials } from "./types";
import { accountScopedProfileArn } from "./kiro";
import { commitKiroDeviceCredential, validStoredClientPart } from "./kiro-device-account";
import { getAccountSet, credentialGeneration } from "./store";

type Method = "builder-id" | "google" | "github";
type Status = "pending" | "done" | "expired" | "error" | "cancelled";
type PublicView = { flowId: string; status: Status; url?: string; deviceCode?: string;
  expiresInSeconds: number; accountId?: string; error?: string };
type PrivateFlow = { id: string; method: Method; slotId: string; reauth: boolean;
  originalGeneration?: string; originalIdentity?: string; deviceCode: string;
  registration?: { clientId: string; clientSecret: string; region: string };
  deadline: number; nextPoll: number; intervalMs: number; status: Status;
  url: string; userCode: string; inFlight?: Promise<PublicView> };
const flows = new Map<string, PrivateFlow>();
const MAX_FLOWS = 32;
const HOST = "https://prod.us-east-1.auth.desktop.kiro.dev";
const OIDC = "https://oidc.us-east-1.amazonaws.com";
const APPROVAL_WAIT_MAX_MS = 20_000;
const MAX_JSON_BYTES = 64 * 1024;
type DeviceErrorCode = "authorization_pending" | "slow_down" | "expired_token";
function knownDeviceErrorCode(raw: string | undefined): DeviceErrorCode | undefined {
  switch (raw?.toLowerCase()) {
    case "authorization_pending": case "authorizationpendingexception": return "authorization_pending";
    case "slow_down": case "slowdownexception": return "slow_down";
    case "expired_token": case "expiredtokenexception": return "expired_token";
    default: return undefined;
  }
}

// Implement postJson with an injectable fetch, AbortSignal.timeout, exact allowlisted
// host/path, bounded response read, JSON object check, and closed-set error extraction.
// Never return/log request body, response body, deviceCode, tokens or registration.
async function postJson(url: string, payload: Record<string, unknown>, fetcher: typeof fetch):
  Promise<{ status: number; body: Record<string, unknown>; errorCode?: DeviceErrorCode }> {
  const res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(APPROVAL_WAIT_MAX_MS) });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Kiro device response unavailable");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_JSON_BYTES) { await reader.cancel(); throw new Error("Kiro device response too large"); }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  let body: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; }
  catch { /* unknown upstream shape is an ordinary failure */ }
  const headerCode = res.headers.get("x-amzn-errortype")?.split(":")[0];
  // Use these strings only for an exact allowlist lookup; never log or return them.
  const rawCode = typeof body.error === "string" ? body.error : headerCode;
  const errorCode = knownDeviceErrorCode(rawCode); // maps only the known pending/slow/expired spellings
  return { status: res.status, body, ...(errorCode ? { errorCode } : {}) };
}
function boundedMs(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function terminal(flow: PrivateFlow, status: Exclude<Status, "pending">): void {
  flow.status = status;
  flow.deviceCode = "";
  flow.registration = undefined;
}
function view(flow: PrivateFlow): PublicView {
  return { flowId: flow.id, status: flow.status, url: flow.url,
    deviceCode: flow.userCode, expiresInSeconds: Math.max(0, Math.ceil((flow.deadline - Date.now()) / 1000)),
    ...(flow.status === "done" ? { accountId: flow.slotId } : {}),
    ...(flow.status === "error" ? { error: "Kiro device authorization failed; retry login." } : {}) };
}
export async function startKiroDeviceLogin(input: { method: Method; accountId?: string; reauth?: boolean },
  fetcher: typeof fetch = fetch): Promise<PublicView> {
  if (!(["builder-id", "google", "github"] as string[]).includes(input.method)) throw new Error("Unknown Kiro login method");
  // Defense in depth: a reauth request without an exact slot must fail before registration.
  if (input.reauth && !input.accountId?.trim()) throw new Error("Kiro reauth requires accountId");
  for (const [id, f] of flows) if (f.deadline <= Date.now() || f.status !== "pending") flows.delete(id);
  if (flows.size >= MAX_FLOWS) throw new Error("Too many Kiro logins in progress");
  const existing = input.accountId ? getAccountSet("kiro")?.accounts.find(a => a.id === input.accountId) : undefined;
  if (input.accountId && !existing) throw new Error("Unknown account for reauth");
  const originalIdentity = existing?.credential.accountId ?? existing?.credential.email?.toLowerCase();
  if (existing && !originalIdentity) throw new Error("Reauth requires a verified account identity");
  const registrationResult = input.method === "builder-id" ? await postJson(`${OIDC}/client/register`,
    { clientName: "kiro-cli", clientType: "public", scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"] }, fetcher) : undefined;
  if (registrationResult && (registrationResult.status < 200 || registrationResult.status >= 300
      || !validStoredClientPart(registrationResult.body.clientId)
      || !validStoredClientPart(registrationResult.body.clientSecret)))
    throw new Error("Kiro device registration failed");
  const registration = registrationResult ? { clientId: registrationResult.body.clientId as string,
    clientSecret: registrationResult.body.clientSecret as string, region: "us-east-1" } : undefined;
  const result = input.method === "builder-id"
    ? await postJson(`${OIDC}/device_authorization`, { clientId: registration!.clientId, clientSecret: registration!.clientSecret, startUrl: "https://view.awsapps.com/start" }, fetcher)
    : await postJson(`${HOST}/oauth/device/authorization`, { clientId: "kiro-cli", loginProvider: input.method === "google" ? "Google" : "Github" }, fetcher);
  const body = result.body;
  if (result.status < 200 || result.status >= 300 || typeof body.deviceCode !== "string" || !body.deviceCode || typeof body.userCode !== "string" || typeof body.verificationUri !== "string") throw new Error("Kiro device authorization failed");
  const ttl = input.method === "builder-id" ? boundedMs(body.expiresIn, 600, 1, 900) * 1000 : boundedMs(body.expiresInMilliseconds, 300_000, 1000, 900_000);
  const intervalMs = input.method === "builder-id" ? boundedMs(body.interval, 5, 1, 60) * 1000 : boundedMs(body.intervalInMilliseconds, 5000, 1000, 60_000);
  const flow: PrivateFlow = { id: randomUUID(), method: input.method, slotId: input.accountId ?? randomUUID(), reauth: !!input.accountId,
    ...(existing ? { originalGeneration: credentialGeneration(existing.credential), originalIdentity } : {}),
    deviceCode: body.deviceCode, ...(registration ? { registration } : {}), deadline: Date.now() + ttl,
    nextPoll: Date.now() + intervalMs, intervalMs, status: "pending", url: body.verificationUri,
    userCode: body.userCode };
  flows.set(flow.id, flow);
  return view(flow);
}
export async function pollKiroDeviceLogin(flowId: string, expectedSlotId?: string,
  fetcher: typeof fetch = fetch): Promise<PublicView> {
  const flow = flows.get(flowId);
  if (!flow || (expectedSlotId && expectedSlotId !== flow.slotId)) throw new Error("Unknown Kiro login flow");
  if (flow.deadline <= Date.now()) { terminal(flow, "expired"); return view(flow); }
  if (flow.status !== "pending") return view(flow);
  if (Date.now() < flow.nextPoll) return view(flow);
  if (flow.inFlight) return flow.inFlight;
  flow.inFlight = (async () => {
    flow.nextPoll = Date.now() + flow.intervalMs;
    const result = flow.method === "builder-id"
      ? await postJson(`${OIDC}/token`, { clientId: flow.registration!.clientId, clientSecret: flow.registration!.clientSecret,
          deviceCode: flow.deviceCode, grantType: "urn:ietf:params:oauth:grant-type:device_code" }, fetcher)
      : await postJson(`${HOST}/oauth/device/poll`, { clientId: "kiro-cli", deviceCode: flow.deviceCode }, fetcher);
    if (flow.status !== "pending" || flow.deadline <= Date.now()) { terminal(flow, "expired"); return view(flow); }
    const code = result.errorCode;
    if (flow.method === "builder-id" && result.status === 400 && code === "authorization_pending") return view(flow);
    if (flow.method === "builder-id" && result.status === 400 && code === "slow_down") { flow.intervalMs += 5000; flow.nextPoll = Date.now() + flow.intervalMs; return view(flow); }
    if (flow.method === "builder-id" && result.status === 400 && code === "expired_token") { terminal(flow, "expired"); return view(flow); }
    if (flow.method !== "builder-id" && result.status === 200 && result.body.status === "authorization_pending") return view(flow);
    if (result.status !== 200 || typeof result.body.accessToken !== "string" || typeof result.body.refreshToken !== "string") { terminal(flow, "error"); return view(flow); }
    const profileArn = flow.method === "builder-id" ? undefined : accountScopedProfileArn(result.body.profileArn);
    if (flow.method !== "builder-id" && !profileArn) { terminal(flow, "error"); return view(flow); }
    const cred: OAuthCredentials = { access: result.body.accessToken, refresh: result.body.refreshToken,
      expires: Date.now() + boundedMs(result.body.expiresIn, 3600, 60, 86_400) * 1000, source: "oauth",
      ...(profileArn ? { accountId: profileArn } : {}),
      kiro: flow.registration ? { ssoRegion: flow.registration.region, clientId: flow.registration.clientId,
        clientSecret: flow.registration.clientSecret } : { profileArn, ssoRegion: "us-east-1" } };
    // The account writer rechecks flow ownership, expiry, slot generation and identity
    // *inside* the protected store mutation. A Builder ID reauth with no stable identity
    // is rejected; a new Builder ID slot is identity-less and never uses the service ARN.
    try { await commitKiroDeviceCredential(flow, cred, () => flows.get(flowId) === flow && flow.status === "pending" && Date.now() < flow.deadline); terminal(flow, "done"); }
    catch { terminal(flow, "error"); }
    return view(flow);
  })().finally(() => { flow.inFlight = undefined; });
  return flow.inFlight;
}
export function cancelKiroDeviceLogin(flowId: string): boolean {
  const flow = flows.get(flowId);
  if (!flow || flow.status !== "pending") return false;
  terminal(flow, "cancelled");
  flows.delete(flowId);
  return true;
}
```

`NEW src/oauth/kiro-device-account.ts` — protected, selection-preserving commit. Complete implementation skeleton:

```ts
import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig } from "../config";
import { upsertOAuthProvider } from "./index";
import { credentialGeneration, mutateStore } from "./store";
import type { OAuthCredentials, ProviderAccount } from "./types";

export interface KiroDeviceCommitTarget {
  method: "builder-id" | "google" | "github";
  slotId: string;
  reauth: boolean;
  originalGeneration?: string;
  originalIdentity?: string;
}
function identity(cred: OAuthCredentials): string | undefined {
  return cred.accountId ?? cred.email?.trim().toLowerCase();
}
// Match src/oauth/store.ts:532-543 before using or persisting either client string.
export function validStoredClientPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
type DeviceWriteReceipt = { previousAccount?: ProviderAccount; previousActiveId?: string;
  selectionRevision?: string; generation: string; writtenLoginId: string };
export async function commitKiroDeviceCredential(
  target: KiroDeviceCommitTarget,
  credential: OAuthCredentials,
  isOwner: () => boolean,
): Promise<void> {
  if (!credential.access || !credential.refresh || credential.access.length > 16_384
      || credential.refresh.length > 16_384 || !Number.isFinite(credential.expires))
    throw new Error("Invalid Kiro device credential");
  // The store drops invalid client fields on reload; reject before an approved write.
  if (target.method === "builder-id") {
    if (!validStoredClientPart(credential.kiro?.clientId)
        || !validStoredClientPart(credential.kiro?.clientSecret))
      throw new Error("Invalid Kiro Builder registration");
  }
  const prospective = loadConfig();
  upsertOAuthProvider(prospective, "kiro"); // Validate config before any credential write.
  const assertOwner = () => { if (!isOwner()) throw new Error("Kiro flow is no longer current"); };
  const receipt = await mutateStore(store => {
    assertOwner();
    const set = store.kiro;
    const previousActiveId = set?.activeAccountId;
    let previousAccount: ProviderAccount | undefined;
    // 010's per-login fence: allocate inside this protected write, even for same-slot reauth.
    const writtenLoginId = randomUUID();
    if (target.reauth) {
      const account = set?.accounts.find(a => a.id === target.slotId);
      if (!account || !target.originalGeneration
          || credentialGeneration(account.credential) !== target.originalGeneration)
        throw new Error("Kiro reauth slot changed");
      const oldIdentity = identity(account.credential);
      const newIdentity = identity(credential);
      if (!oldIdentity || !newIdentity || oldIdentity !== target.originalIdentity
          || oldIdentity !== newIdentity)
        throw new Error("Kiro reauth identity mismatch");
      previousAccount = structuredClone(account);
      account.credential = structuredClone(credential);
      account.loginId = writtenLoginId;
      delete account.needsReauth;
    } else if (!set) {
      store.kiro = { activeAccountId: target.slotId,
        accounts: [{ id: target.slotId, credential: structuredClone(credential), addedAt: Date.now(), loginId: writtenLoginId }] };
    } else {
      const newIdentity = identity(credential);
      if (set.accounts.some(a => a.id === target.slotId
          || (newIdentity && identity(a.credential) === newIdentity)))
        throw new Error("Kiro account already exists");
      set.accounts.push({ id: target.slotId, credential: structuredClone(credential), addedAt: Date.now(), loginId: writtenLoginId });
      // Deliberately leave activeAccountId and selectionRevision alone.
    }
    return { previousAccount, previousActiveId,
      generation: credentialGeneration(credential), writtenLoginId } as DeviceWriteReceipt;
  }, [target.slotId, credential], {
    assertBeforePersist: assertOwner,
    // mutateStore may assign a new revision AFTER the callback, especially on the
    // first account-set creation. Capture the revision that actually persists.
    finalizeResult: (written, store) => {
      written.selectionRevision = store.kiro?.selectionRevision;
    },
  });
  try {
    // Fresh read avoids publishing over an unrelated earlier config mutation.
    const latest = loadConfig();
    upsertOAuthProvider(latest, "kiro");
    assertOwner();
    saveConfig(latest);
  } catch (error) {
    await mutateStore(store => {
      const set = store.kiro;
      const index = set?.accounts.findIndex(a => a.id === target.slotId) ?? -1;
      if (!set || index < 0 || set.selectionRevision !== receipt.selectionRevision
          || set.accounts[index]!.loginId !== receipt.writtenLoginId
          || credentialGeneration(set.accounts[index]!.credential) !== receipt.generation) return;
      if (receipt.previousAccount) set.accounts[index] = receipt.previousAccount; // Restores prior loginId too.
      else set.accounts.splice(index, 1);
      if (set.accounts.length === 0) delete store.kiro;
      else if (receipt.previousActiveId) set.activeAccountId = receipt.previousActiveId;
    }, [target.slotId]);
    throw error;
  }
}
```

On a late write failure, the receipt compares the *persisted* selection revision, slot generation, and newly written login ID. For the first credential, `mutateStore` creates a revision during bookkeeping; capturing it through `finalizeResult` makes config-save failure remove the new set. Reauth compensation restores the whole cloned prior `ProviderAccount`, including its prior `loginId`, credential, and `needsReauth` state. A concurrent selection or replacement wins; report the failed login without overwriting that later action. The protected writer validates both Builder client strings again, even if start already validated the registration. This module never calls `kiro-cli`, `saveCredentialWithReceipt`, or `saveAccountCredential`. `auth.json` is the only durable Builder registration location; there is no pending-flow disk file. `PrivateFlow` is structural input to `KiroDeviceCommitTarget`, and no flow object is serialized wholesale. `validStoredClientPart` is an internal cross-module export, not a CLI or package API; start and commit use exactly the same predicate.

`MODIFY src/oauth/kiro.ts`:

```diff
-/** Account identity must never use the request-scoped Builder ID service profile. */
-function accountScopedProfileArn(value: unknown): string | undefined {
+/** Account identity must never use the request-scoped Builder ID service profile. */
+export function accountScopedProfileArn(value: unknown): string | undefined {
```

`MODIFY src/server/management/oauth-account-routes.ts` (insert the Kiro branch after public-provider/collision validation and before generic `startLoginFlow`; never echo upstream error text):

```diff
-    const body = await readManagementJsonBodyOr(req, {}) as { provider?: string; addAccount?: boolean; accountId?: string; reauth?: boolean; openBrowser?: unknown };
+    const body = await readManagementJsonBodyOr(req, {}) as { provider?: string; addAccount?: boolean; accountId?: string; reauth?: boolean; openBrowser?: unknown; method?: string };
@@
     const accountId = body.accountId?.trim();
     const reauth = body.reauth === true || Boolean(accountId);
+    if (provider === "kiro") {
+      // Explicit reauth without a bound account must never become add-account.
+      if (body.reauth === true && !accountId)
+        return jsonResponse({ error: "Kiro reauth requires accountId" }, 400);
+      const { startKiroDeviceLogin } = await import("../../oauth/kiro-device-login");
+      const method = body.method ?? "builder-id";
+      if (method !== "builder-id" && method !== "google" && method !== "github")
+        return jsonResponse({ error: "Unknown Kiro login method" }, 400);
+      try {
+        const flow = await startKiroDeviceLogin({ method, reauth: body.reauth === true,
+          ...(accountId ? { accountId } : {}) });
+        return jsonResponse({ flowId: flow.flowId, url: flow.url, deviceCode: flow.deviceCode,
+          instructions: "Approve Kiro sign-in with the displayed code." });
+      } catch { return jsonResponse({ error: "Kiro device login could not start" }, 409); }
+    }
@@
   if (url.pathname === "/api/oauth/login/cancel" && req.method === "POST") {
-    const body = await readManagementJsonBodyOr(req, {}) as { provider?: string };
+    const body = await readManagementJsonBodyOr(req, {}) as { provider?: string; flowId?: string };
@@
     if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
+    if (provider === "kiro") {
+      const { cancelKiroDeviceLogin } = await import("../../oauth/kiro-device-login");
+      return jsonResponse({ ok: true, cancelled: typeof body.flowId === "string" && cancelKiroDeviceLogin(body.flowId) });
+    }
@@
   if (url.pathname === "/api/oauth/status" && req.method === "GET") {
     const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
     if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
+    if (provider === "kiro" && url.searchParams.has("flowId")) {
+      const { pollKiroDeviceLogin } = await import("../../oauth/kiro-device-login");
+      try { return jsonResponse(await pollKiroDeviceLogin(url.searchParams.get("flowId") ?? "", url.searchParams.get("accountId") ?? undefined)); }
+      catch { return jsonResponse({ error: "Unknown Kiro login flow" }, 404); }
+    }
```

Before merging, refine the route so *all* Kiro start/poll/cancel paths check the same management-session principal as the current login route. The `flowId` is a capability and is never accepted in another provider's status call. `GET /api/oauth/status` is already a read endpoint, but its Kiro flow-ID variant causes one upstream polling call; document and test that exception. Do not expose `registration`, `deviceCode` (the private device code), or `token` in any public DTO. The public `deviceCode` response key is the *user code* only.

`MODIFY src/cli/account-auth.ts`:

```diff
-  ocx account login <provider> [--id <account-id>] [--reauth] [--device] [--code -] [--no-wait] [--json]
+  ocx account login <provider> [--id <account-id>] [--reauth] [--device] [--method builder-id|google|github] [--code -] [--no-wait] [--json]
@@
  const device = takeFlag(args, "--device");
+  const method = takeOption(args, "--method");
@@
   if (!provider) throw new CliUsageError("provider is required", USAGE);
+  if (method && (provider !== "kiro" || !["builder-id", "google", "github"].includes(method)))
+    throw new CliUsageError("--method requires kiro and builder-id, google, or github", USAGE);
+  if (provider === "kiro" && reauth && !id)
+    throw new CliUsageError("Kiro --reauth requires --id <account-id>", USAGE);
@@
-  const start = await runtimeRequest<LoginStart>("/api/oauth/login", {
+  const start = await runtimeRequest<LoginStart>("/api/oauth/login", {
     method: "POST",
-    body: JSON.stringify({ provider, addAccount: !reauth, ...(reauth && id ? { accountId: id, reauth: true } : {}) }),
+    body: JSON.stringify({ provider, addAccount: !reauth, ...(reauth && id ? { accountId: id, reauth: true } : {}),
+      ...(provider === "kiro" ? { method: method ?? "builder-id" } : {}) }),
@@
   if (noWait) {
@@
   }
+  if (provider === "kiro") {
+    if (!start.flowId) throw new CliUsageError("Kiro login did not return a flow id");
+    for (let attempt = 0; attempt < 450; attempt++) {
+      await Bun.sleep(2_000);
+      const state = await runtimeRequest<{ status: string; accountId?: string; error?: string }>(
+        `/api/oauth/status?provider=kiro&flowId=${encodeURIComponent(start.flowId)}${id ? `&accountId=${encodeURIComponent(id)}` : ""}`, {}, deps);
+      if (state.status === "done") { printData(state, wantsJson, ["Kiro account added."]); return; }
+      if (["error", "expired", "cancelled"].includes(state.status)) throw new CliUsageError(state.error ?? `Kiro login ${state.status}`);
+    }
+    throw new CliUsageError("Kiro login timed out");
+  }
```

Also include `flowId` in the existing `LoginStart` interface at `src/cli/account-auth.ts:68-75` (already present) and print it in the initial block, as the Codex branch does at `:167-169`. The Kiro `--reauth`/`--id` guard must run before `runtimeRequest` and before any approval URL is printed; `ocx account reauth kiro` reaches the same guard through the alias in `src/cli/account-auth.ts:369`. Reject `--code` and `--device` combined with Kiro `--method`: the native device grant needs only the user code displayed at the URL and never accepts a pasted redirect. For `ocx account cancel kiro`, require `--flow` as Codex does and send `{ provider, flowId }` to `/api/oauth/login/cancel`; do not cancel every Kiro flow by provider. `ocx account login kiro --reauth --id X --method google` is the bound replacement syntax. Existing `ocx login kiro`/local import remains available for manual migration, but `ocx account login kiro` is native.

`MODIFY gui/src/pages/use-providers-oauth.ts` and `MODIFY gui/src/components/use-add-provider-oauth.ts` — Kiro's existing Add account and first-login buttons require a flow-bound status check. No new picker is required for this layer; GUI uses Builder ID, while CLI/API expose all three methods. In both files apply these hunks to the existing start and status fetches:

```diff
-            ...(addAccount || reauthTargetId ? { addAccount: true } : {}),
+            ...(addAccount || reauthTargetId ? { addAccount: true } : {}),
+            ...(provider === "kiro" ? { method: "builder-id" } : {}),
@@
-      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string };
+      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; flowId?: string };
@@
-        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).catch(() => null);
+        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${provider}${provider === "kiro" && data.flowId ? `&flowId=${encodeURIComponent(data.flowId)}${reauthTargetId ? `&accountId=${encodeURIComponent(reauthTargetId)}` : ""}` : ""}`).catch(() => null);
```

The Kiro branch in this hook must use `s.status === "done"` rather than provider-wide `s.loggedIn`/count (the current account may already be logged in), and fail on `error|expired|cancelled`. In `use-add-provider-oauth.ts` add `{method:"builder-id"}` when `providerId === "kiro"`, retain `flowId` from the start DTO, poll `/api/oauth/status?provider=kiro&flowId=...`, and treat only `status === "done"` as success. Update the cancel barrier calls in both hooks to send the active Kiro flow ID; a page hide may cancel exactly that flow, never another Kiro flow. The source hunk there is:

```diff
-          body: JSON.stringify({ provider: providerId, ...openBrowserRequestField() }),
+          body: JSON.stringify({ provider: providerId, ...openBrowserRequestField(),
+            ...(providerId === "kiro" ? { method: "builder-id" } : {}) }),
@@
-        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}`).catch(() => null);
+        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${providerId}${providerId === "kiro" && data.flowId ? `&flowId=${encodeURIComponent(data.flowId)}` : ""}`).catch(() => null);
```

`MODIFY gui/src/oauth-cancellation-barrier.ts` — the current helper has only provider-scoped cancellation (`:1-25`), so a Kiro flow ID is required:

```diff
-export function cancelOAuthLogin(apiBase: string, provider: string): Promise<void> {
-  const key = JSON.stringify([apiBase, provider]);
+export function cancelOAuthLogin(apiBase: string, provider: string, flowId?: string): Promise<void> {
+  const key = JSON.stringify([apiBase, provider, flowId ?? null]);
@@
-      body: JSON.stringify({ provider }),
+      body: JSON.stringify({ provider, ...(provider === "kiro" && flowId ? { flowId } : {}) }),
```

Store the active flow ID in each GUI hook's generation record; pass it to `cancelOAuthLogin`, and clear it only after that generation settles. `afterOAuthCancellation` remains the provider-wide start barrier, so it must await every pending cancellation with the same API base and provider even when the cancellation map key includes a flow ID (iterate matching entries, not exact-key lookup). No `ProviderAuthPanel` visual change is needed because it already renders a URL and user code. No translated GUI copy is added.

## PLAN-FIELD-CHAIN-01

| Field / enum | Creation → serialization → deserialization → consumer |
| --- | --- |
| `method: builder-id|google|github` | CLI `src/cli/account-auth.ts`, GUI hooks, or API caller → JSON `/api/oauth/login` → route validates closed set → `startKiroDeviceLogin` selects only allowlisted host and payload. Never persisted: flow policy is process-local. |
| `flowId` | Random UUID at start → JSON start DTO → CLI/GUI retain; URL query `/api/oauth/status` and cancel body → server map lookup → exact flow state. Never persisted; missing/wrong ID is 404/false. |
| `slotId` / `accountId` | New UUID for add, exact stored account ID for reauth → `accountId` returned only at done; optional reauth request query → route/state checks exact slot → `mutateStore` appends/replaces only bound slot. No preapproval serialization. |
| `loginId` | Fresh UUID allocated inside each approved protected `mutateStore` write, whether native add or same-slot reauth → protected `auth.json` account field preserved by 010's `normalizeAccount` → `kiroEvidenceIdentity(account)` invalidates earlier evidence; refresh writers preserve it. The write receipt remembers the new UUID; config-save compensation restores the complete prior account and prior `loginId` for reauth, or removes the newly added account. Never serialized in public DTOs. |
| `originalGeneration`, `originalIdentity` | Captured from one stored account at start → N/A (private memory only) → N/A → protected store mutation checks generation and verified identity before reauth write. |
| `status: pending|done|expired|error|cancelled` | State machine → allowlisted status DTO → CLI/GUI parser → only `done` reports success. No disk state; restart invalidates flow. |
| `registration.clientId/clientSecret/region` | Builder RegisterClient response → validate nonempty, untrimmed-equal, control-free, at most 4096 characters for each client string before authorization → private flow memory → validate again at approved commit → protected `auth.json` (`credential.kiro`) → `normalizeCredential` `src/oauth/store.ts:532-551` retains both → Builder refresh `src/oauth/kiro.ts:573-612` after reload. Never in DTO/log/snapshot; erase registration at every terminal branch and on prune. |
| `kiro.profileArn` social only | Approved social poll, validated by `accountScopedProfileArn` → protected `auth.json` → store normalizer → account identity and request routing. Builder service profile: N/A creation/persistence because `resolveKiroRequestProfile` generates it only per request. |
| `deviceCode` (private), `userCode` (public), `url` | Start response → private `deviceCode` stays in map and poll body; public user code + verification URL alone serialize to start/status DTO → CLI/GUI display and upstream poll. Device code is never deserialized from a client request; terminal flow erases it. |
| `deadline`, `nextPoll`, `intervalMs`, `expiresInSeconds` | Validated upstream seconds or milliseconds → private epoch/interval; only computed `expiresInSeconds` serializes to status → CLI/GUI read expiry hint; state machine enforces deadline and interval. No durable state. |
| `reauth` | CLI `--reauth` or API JSON `reauth:true` → reject before upstream work if `--id`/nonempty `accountId` is absent → route passes the explicit bit to `startKiroDeviceLogin` → private flow bound to the validated slot → protected writer replaces only that slot after generation/identity check. An unbound reauth can never fall through to add. |
| `inFlight` | First poll creates a Promise → N/A, private memory only → N/A → concurrent polls await one upstream call and commit. Cleared after settlement. |
| `error` / `instructions` | Fixed local message at failed/start route → JSON public DTO → CLI/GUI display → operator retries. Upstream text is never serialized. |
| `expires`, `refresh`, `access` | Approved token response → protected `auth.json` only → store normalizer → existing Kiro refresh/request. No token appears in public flow DTO. |
| `kiroEvidenceIdentity(account)` | 010's `src/providers/kiro-account-state-disk.ts` computes SHA-256 hex over `[account.id, account.loginId ?? String(account.addedAt ?? ""), cred.accountId ?? cred.email ?? "", cred.kiro?.profileArn ?? "", cred.kiro?.clientId ?? ""]`, where `cred = account.credential`. The five fields contain no `authType`. Each native add or reauth writes a fresh `loginId`, so even a same-slot social reauth with the same verified profile and client ID changes the hash. The legacy identity-less slot upgrade in `saveCredentialWithReceipt` (`src/oauth/store.ts:855-872`) also changes it. Quota, persisted verdict, refusal, catalogue, and in-flight evidence carrying another identity is absent/unknown. Never use token-based `credentialGeneration()` for this evidence key: it changes on refresh. Routing reads only through 010's `kiroAccountEvidence(account, now?)`, which hydrates once and applies TTL and reset bounds; 060 writes credentials but never reads routing evidence directly. |

All 060 diagnostics use only fixed codes (`registration_invalid`, `authorization_failed`, `poll_failed`, `expired`, `commit_failed`, `rollback_stale`) and the closed flow statuses above. `postJson` reduces upstream error names through `knownDeviceErrorCode`; unknown values become a fixed failure code. Logging sites in start, poll, and commit must pass a fixed code/status explicitly (for example `console.warn("[kiro-device-login]", "commit_failed", "error")`), never an `Error` object, `error.message`, request or response body, raw upstream code, token, private or public device code, registration pair, URL, or account identifier. CLI/API error DTOs remain fixed local messages. The approval URL and user code are displayed only in the intended interactive response, never in diagnostics.

## Conditional-path and test contract

| Activation | Observable assertion |
| --- | --- |
| Builder registration/authorization valid; pending 400; slow_down; approved token | No account before approval; pending remains pending; next poll moves +5 seconds on slow_down; after approval one identity-less Builder slot appears, inactive when an earlier Kiro account exists, with client pair in protected `auth.json` and no profile ARN. |
| Builder RegisterClient returns empty, whitespace-only, control-bearing, or 4097-character `clientId` or `clientSecret` | Start fails before `/device_authorization`; no account/config write and no secret in DTO or logs. A valid 4096-character pair is retained after store reload and accepted by `refreshKiroToken`'s Builder branch. |
| First Kiro credential commits, then `saveConfig` fails | The real `mutateStore` creates a selection revision after the writer callback; receipt gets it via `finalizeResult`. Compensation removes the just-created `kiro` set from the real isolated auth store, leaves config unchanged, and reports failure. A later selection or changed credential generation blocks compensation. |
| CLI `--reauth`/API `reauth:true` without account ID | CLI raises usage before any HTTP request; API returns 400 before registration/authorization; neither path creates a flow or credential. The `ocx account reauth kiro` alias has the same behavior. |
| Social Google or GitHub authorization valid, HTTP 200 pending, approved with valid profile | Each method sends its exact `loginProvider`; pending persists nothing; approval appends a separate profile-bound slot without switching active. |
| Social approval with absent/invalid/service profile, missing refresh, malformed JSON, oversized response, unknown status/error code | `error` with fixed public text; no credential/config write, no CLI session mutation. This is the **unrecognised upstream shape stays harmless** case. |
| Reauth for wrong identity, missing identity (Builder), changed credential generation, removed target slot | Error; original credential and active selection remain byte-for-byte unchanged. |
| Approved native add and same-slot social reauth | Each protected write persists a fresh UUID `loginId`; reauth retains the account ID and verified profile but changes `kiroEvidenceIdentity(account)`. Previously cached quota, persisted verdict, refusal, catalogue, and in-flight evidence for that slot read as absent/unknown at the first routing decision; token refresh alone keeps the `loginId` and evidence identity. |
| Same-slot social reauth writes, then `saveConfig` fails | Compensation restores the entire prior account, including its previous `loginId`, credential, and `needsReauth`; old evidence identity is restored. A later write with the same credential generation but a different `loginId` prevents stale compensation. |
| Poll/cancel wrong flow ID, another flow's slot ID, expired flow, cancelled flow, concurrent polls | No cross-flow completion; expired/cancelled never commit; concurrent polls join one upstream request and one store commit. |
| Registration secret embedded in upstream error body or token | Response, status, log buffer, request snapshot and CLI JSON omit it; protected `auth.json` alone holds approved client registration. |
| Unknown upstream error text or exception includes a sentinel token/device code/client secret | Start, poll, route, CLI, and commit diagnostics contain only the fixed codes and flow statuses above; no raw exception or upstream text reaches logs or DTOs. |
| Existing active Kiro account while adding a new one | Active ID unchanged. Proactive preferred-account and least-loaded choices require effective pool enablement; 030's known suspended/monthly-exhausted exclusion and a configured concurrency cap still apply at initial admission. A singleton or all-excluded pool sends to the active account. 060 has no selection side effect and never touches the `kiro-cli` database or process. |

## Tests and registry edits

The baseline at `tests/fixtures/file-size-baseline.json:37,46-47` caps `tests/cli/cli-account.test.ts` (2313), Kiro adapter (2050), and stream (2258); add **no lines** there. New sibling files:

- `tests/oauth/kiro-device-builder.test.ts`: `Builder ID stays pending until approval`, `slow_down extends the poll interval`, `approved Builder ID stores registration privately and no service profile`, `approved Builder add persists a fresh loginId` (UUID survives store reload), `expired Builder ID never commits`, `unknown Builder response leaves auth and config untouched`, `Builder reauth without verified identity is refused`, `first Builder credential config failure removes the real store set` (inject `saveConfig` failure after approved `mutateStore`; reload the isolated real store and assert `getAccountSet("kiro") === null`, unchanged config, and error result), `Builder registration rejects invalid client fields before authorization` (table of empty, whitespace-only, control-bearing, and 4097-character values for each field; assert no device authorization request), `Builder registration survives reload and refresh` (4096-character valid pair; reload auth store and use an injected refresh fetch to assert both original values are sent and a refreshed credential is returned).
- `tests/oauth/kiro-device-social.test.ts`: `Google and GitHub send distinct provider names`, `social pending 200 does not commit`, `approved social profile appends without switching active`, `approved social add persists a fresh loginId`, `social missing or service profile is refused`, `social reauth rejects a different identity and generation`, `same-slot native reauth rotates loginId and invalidates evidence` (seed quota, persisted verdict, refusal, catalogue, and in-flight evidence for the old five-field hash; approve a same-profile reauth; reload and assert new UUID, unchanged slot/profile, changed hash, and absent/unknown reads through `kiroAccountEvidence(account, now?)`), `social reauth config failure restores prior account and loginId` (inject `saveConfig` failure; reload and compare the whole account, old hash, and active selection), `stale compensation cannot overwrite a later loginId` (same credential generation, different UUID), `cross-flow and expired completion are refused`.
- `tests/server/kiro-device-login-routes.test.ts`: `management start/status/cancel are bound to flowId and slot`, `unapproved flow reveals no device secret or client registration`, `token response and request snapshot never contain Builder registration`, `wrong flow cannot finish another slot`, `unbound Kiro reauth returns 400 without registration` (POST `{provider:"kiro",reauth:true}` and whitespace `accountId`; assert no flow/fetch and no store change), `Kiro diagnostics exclude upstream secrets and raw errors` (sentinel in error body and thrown exception; inspect captured logs and JSON for absence, and closed codes/statuses only).
- `tests/cli/cli-account-kiro-device.test.ts`: `account login kiro selects the requested method`, `CLI prints approval URL and user code before polling`, `CLI waits for its own flow and reports only its completed account`, `cancel kiro requires and forwards flowId`, `Kiro code paste and unsupported method are rejected`, `Kiro reauth without id makes no request` (both `login kiro --reauth` and `reauth kiro` aliases; expect `CliUsageError` and zero runtime requests).
- `tests/gui/kiro-device-login-ui.test.ts`: `existing Kiro Add account requests Builder ID and polls its flow`, `pre-existing logged-in Kiro account does not prematurely complete add`, `modal cancellation targets the current flow`.

Add these exact `explicit` entries inside `scripts/test-layout/layout.json` (the file's explicit object starts at `:230`, map shape is `"filename.test.ts": "domain"`):

```json
"kiro-device-builder.test.ts": "oauth",
"kiro-device-social.test.ts": "oauth",
"kiro-device-login-routes.test.ts": "server",
"cli-account-kiro-device.test.ts": "cli",
"kiro-device-login-ui.test.ts": "gui",
```

Add the same five exact key/value lines to `tests/fixtures/test-layout-expected.json` (existing sibling conventions at `:326-332,1087-1113`). None of these basenames already exists. Test with isolated `OPENCODEX_HOME`, injected fetch, and sentinel secrets; assert the actual persisted store and serialized management/CLI output. Test both a valid and an unknown upstream shape without network access. If the GUI cancellation helper change creates a new helper test, register its basename in both maps too. Run `bun test tests/test-layout-tooling.test.ts` after registry edits.

## Docs and structure ownership

- `docs-site/src/content/docs/reference/cli/providers-accounts.md:381-383`: replace the CLI handoff sentence with: “`ocx account login kiro` starts native Builder ID device authorization; `--method google` and `--method github` use Kiro social device authorization. Adding an account keeps the active OpenCodex account and the installed `kiro-cli` session unchanged. Reauth requires `--reauth --id <account-id>` and a verified identity; identity-less Builder ID slots cannot be replaced by an unverified device result.” Update translated `providers-accounts.md` pages only where they currently contradict this flow; do not invent translated details.
- `structure/providers-and-adapters.md:78`: state that native device login owns Builder client registration in protected `auth.json`, binds the flow to one slot, and refuses identity-less reauth; keep the existing CLI-import identity paragraph for the legacy path.
- `structure/runtime.md` and `structure/gui-and-management-api.md` (owners of `src/oauth/`, `src/cli/`, `src/server/` per `structure/INDEX.md`): add one sentence to the account/login sections describing flow-ID-bound Kiro status and the approved-only credential write. `structure/ops/docs-and-release.md` describes `docs-site/` and `src/cli/`; review it for a contradictory CLI command claim, otherwise no text change. `structure/INDEX.md` is generated; do not edit it by hand. Run `bun run structure:check` after changing owner docs.
The sentence-level `MODIFY` hunks are:

```diff
--- a/docs-site/src/content/docs/reference/cli/providers-accounts.md
+++ b/docs-site/src/content/docs/reference/cli/providers-accounts.md
@@
-`ocx account login kiro` hands off to the Kiro CLI and appends the new account to the pool.
+`ocx account login kiro` starts native Builder ID device authorization; `--method google`
+and `--method github` use Kiro social device authorization. Adding an account keeps the
+active OpenCodex account and the installed `kiro-cli` session unchanged. Reauth requires
+`--reauth --id <account-id>` and a verified identity; an identity-less Builder ID slot
+cannot be replaced by an unverified device result.
--- a/structure/providers-and-adapters.md
+++ b/structure/providers-and-adapters.md
@@
-| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. Meta Muse device authorization, polling, and key-mint JSON responses share the 64 KiB bounded-body ceiling and the request's deadline; oversized declared or streamed bodies are rejected before JSON parsing. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. Command Code manual callback JSON remains opaque to the shared `code#state` parser and is state-validated by its provider parser. A raw Command Code paste with an explicit `#state` suffix must match the flow state on the direct prompt as well. Kiro add-account identity prefers same-session `whoami` over a leftover SQLite state profile, and never persists the Builder ID service profile ARN as `accountId`. |
+| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. Meta Muse device authorization, polling, and key-mint JSON responses share the 64 KiB bounded-body ceiling and the request's deadline; oversized declared or streamed bodies are rejected before JSON parsing. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. Command Code manual callback JSON remains opaque to the shared `code#state` parser and is state-validated by its provider parser. A raw Command Code paste with an explicit `#state` suffix must match the flow state on the direct prompt as well. Legacy Kiro import identity prefers same-session `whoami` over a leftover SQLite state profile. Native Kiro device login binds approval to one account slot, stores Builder registration only in protected `auth.json`, and refuses identity-less reauth. Neither path persists the Builder ID service profile ARN as `accountId`. |
--- a/structure/runtime.md
+++ b/structure/runtime.md
@@
 ## CLI readiness diagnostics
+
+`ocx account login kiro` runs a process-owned Builder ID, Google, or GitHub device flow;
+the CLI polls its exact flow ID and never switches the installed `kiro-cli` session.
--- a/structure/gui-and-management-api.md
+++ b/structure/gui-and-management-api.md
@@
-## Authentication boundaries
+Kiro's dashboard Add account action uses a flow-ID-bound device login. The management
+status route may poll only that flow; approval alone permits a protected credential write.
+
+## Authentication boundaries
```

`MODIFY scripts/test-layout/layout.json` and `MODIFY tests/fixtures/test-layout-expected.json` each receive the five exact registry lines above (the before state has no such basenames; the after state inserts those lines into the existing `explicit`/flat object). Test files are NEW at the five paths above; each contains the named cases with injected upstream fetch and temporary home. Translated `providers-accounts.md` files need sentence-level updates where the Kiro CLI handoff is stated; enumerate the affected locales at the 060 head before editing and do not alter unrelated translations.

- `AGENTS.md` lab boundary: the new module may be imported only by the management route and Kiro account writer. It must not become reachable from `src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts` through `src/lab/`.

## PLAN-VERIFIER-REAL-01

| Command run on current unchanged tree | Exit / observed result | Reads layer 060 target? |
| --- | --- | --- |
| `bun test tests/providers/kiro/kiro-oauth.test.ts` | 0; 60 pass, 0 fail, 192 assertions | No new module exists; exercises old Kiro import/refresh, including Builder metadata. |
| `bun test tests/cli/cli-account-cancel-flow.test.ts` | 0; 2 pass, 0 fail, 13 assertions | No; old CLI cancellation path only. |
| `bun test tests/lab/core-lab-boundary.test.ts` | 0; 25 pass, 0 fail, 91 assertions | No; future import graph gate after implementation. |

Dependencies are installed in this checkout. For 060 implementation, run the five new files, the three existing files above, `bun test tests/test-layout-tooling.test.ts`, `bun run typecheck`, `bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`, and exact-head hosted CI. These future commands are **named, not claimed run**. `tests/server/account-pool-management-api.test.ts` is a known local environment exception because this worktree is under `~/.codex`: its test-home guard refuses removal inside the real Codex home. Record that specific failure as environment-only and use the hosted CI run for that test's passing evidence; do not count the local failure as a product regression or claim it passed. A full local `bun run test` remains the default before review readiness; if concurrent worktrees make it disproportionate, record the exact focused scope and leave the PR draft until CI covers it. After adding the new GUI behavior, run `bun run lint:gui` and `bun run build:gui` and attach a GUI screenshot to the PR description under repository policy.

## Risks, rollback, and out of scope

The reference social and OIDC shapes have not been observed live from this proxy; only closed-set success/pending responses may create credentials. Builder ID device tokens may lack a stable identity; the safe consequence is add-only, with reauth refused until an independently verified identity exists. A server restart loses pending flows and the operator starts again; no pending secret is restored from disk. A cancellation racing an already persisted approval is handled by the store ownership check before write; once committed, cancellation reports terminal and cannot undo a valid account. A config-save compensation race must refuse to overwrite a newer account or selection and surface the failure for manual review. Roll back 060 by reverting its two commits; existing `auth.json` credentials remain readable by the current Kiro refresh path, and no Kiro CLI session was changed. No live AWS/Kiro calls, alternate endpoint dialects, profile discovery for Builder ID, or service-profile identity persistence belong in this layer.

## Round-1 audit fold

- `r3-1` → Capture the *persisted* selection revision through `mutateStore.finalizeResult` and compare it during compensation (`:264-291`); the first-account real-store config failure test removes the newly created set (`:461`, `:477`).
- `r3-2` → Reject `reauth:true` without `accountId` in the route and state machine (`:109-117`, `:315-324`), and reject CLI `--reauth` without `--id` before any request (`:360-367`); API and CLI regressions are named at `:479-480`.
- `r3-5` → Validate both Builder client strings against the store's nonempty, control-free, 4096-character limit before authorization and at commit (`:123-129`, `:208-227`); reload/refresh and invalid-registration assertions are at `:460`, `:477`.
- Shared decisions touched here → `kiroEvidenceIdentity` and `kiroAccountEvidence` field chain (`:451`), effective-pool activation (`:471`), #5937 probe context and planned `kiroManagementHost` (`:16`), closed diagnostic codes (`:453`, `:470`), and fresh verifier results plus the `~/.codex` test-home exception (`:538-546`). No shared API name deviates.

## Round-2 audit fold

- `r3-R2-1` (High) → Native writer allocates a UUID inside the protected mutation and assigns it on both add paths and same-slot reauth (`:232-265`); receipt fences compensation on that UUID and restores the entire prior account, including its `loginId` (`:280-297`). Named Builder and social add, evidence-invalidation, compensation, and stale-compensation tests are at `:477-478`. **rebase-verify at this layer's P** against 010's `ProviderAccount.loginId` and store normalizer.
- `r3-R2-3` (Medium, this 060 hunk) → Field chain uses `kiroEvidenceIdentity(account)` with exactly five fields, including `loginId` and no `authType`, and routes through `kiroAccountEvidence(account, now?)` (`:440`, `:451`); same-slot reauth test asserts the old evidence is unknown (`:466`, `:478`). **rebase-verify at this layer's P** against 010's `kiro-account-state-disk.ts` contract. The separate 020 hunk belongs to its own layer.
