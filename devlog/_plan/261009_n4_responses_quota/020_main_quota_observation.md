# 020 — wp2: credential-bound main quota observation (#6800)

## Root cause (verified at 730d898457)

Quota from upstream response headers is recorded only inside
`if (usesCodexForwardPoolAuth(authCtx, provider))`
(`src/server/responses/passthrough-delivery.ts:486`), and the WebSocket observer has the
same gate (`core-codex-account.ts:124`). `usesCodexForwardPoolAuth` admits auth-context
kinds `pool` and `main-pool`. A request served with the main login as a plain
`{ kind: "main" }` context — the caller's own ChatGPT bearer, or the stored main
substituted for an admission bearer — never records its headers, so `__main__` in
`codex-quota-cache.json` keeps its last WHAM/probe value while pool rows refresh on every
response. The reporter (Codex CLI, main Pro + two Plus pool accounts, HTTP fallback after a
WebSocket 426) describes exactly that asymmetry.

## Design

Record a plain-main response into `__main__` only when the credential actually sent
upstream is the main credential the proxy has already observed from its own read, and only
if that observation is still current when the response arrives.

The process already has the matching primitive: `matchesMainQuotaCredential(accessToken,
accountId)` in `src/codex/main-account-cache.ts` compares a process-local HMAC of the
bearer plus the account identity key against the credential observed from an owned read.
It is what `callerMatchesObservedMain` uses today to decide that the hard-lock policy
applies to a caller-owned request, so quota recording follows the same trust rule.

`usesCodexForwardPoolAuth` is not widened: its block also owns pool health, failover and
quarantine, none of which apply to a caller-owned credential.

### `src/codex/main-account-cache.ts` (MODIFY)

```ts
/** Proof that a dispatch used the observed main credential; process-local, never persisted. */
export type MainQuotaDispatch = Readonly<{
  writer: MainQuotaWriter;
  credentialGeneration: number;
  configGeneration: number;
}>;

export function captureMainQuotaDispatch(
  accessToken: string, accountId: string | undefined, configGeneration: number,
): MainQuotaDispatch | undefined {
  if (!accountId || !matchesMainQuotaCredential(accessToken, accountId)) return undefined;
  const writer = captureMainQuotaWriter(accountId);
  return writer ? { writer, credentialGeneration: mainQuotaCredentialGeneration, configGeneration } : undefined;
}

export function isMainQuotaDispatchLive(dispatch: MainQuotaDispatch): boolean {
  return isMainQuotaWriterLive(dispatch.writer)
    && dispatch.credentialGeneration === mainQuotaCredentialGeneration;
}
```

The credential generation fence rejects a response that arrives after the main credential
was replaced (including same-account token rotation, which leaves the writer live) or after
an A→B→A identity change.

### `src/codex/auth-context.ts` (MODIFY)

```diff
 import {
   captureMainQuotaWriter,
+  captureMainQuotaDispatch,
   ...
+  type MainQuotaDispatch,
 } from "./main-account-cache";

 export type CodexAuthContext =
-  | { kind: "main"; accountId: null; reserveAuthorization?: MainReserveAuthorization }
+  | {
+      kind: "main"; accountId: null; reserveAuthorization?: MainReserveAuthorization;
+      /** Set by materialization when the bearer sent upstream is the observed main credential. */
+      mainQuotaDispatch?: MainQuotaDispatch;
+    }

+/** Dispatch proof for the credential actually selected; identity comes only from an owned observation. */
+function selectedMainQuotaDispatch(selected: Headers): MainQuotaDispatch | undefined {
+  const bearer = selected.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
+  if (!bearer) return undefined;
+  const accountId = selected.get("chatgpt-account-id") ?? extractAccountId(undefined, bearer);
+  return captureMainQuotaDispatch(bearer, accountId, captureConfigGeneration());
+}

 export function materializeCodexUpstreamAuth(...): Headers {
   const selected = new Headers();
   ...
+  if (ctx.kind === "main") ctx.mainQuotaDispatch = undefined;
   if (ctx.kind === "pool" || ctx.kind === "main-pool") { ... unchanged ... }
   ...
   if (ctx.kind === "main" && options.substituteMainCredential === true) {
     ...
     observeSelectedMainCredential(stored, writer);
     assertMainAccountPolicy(options.config);
     assertMaterializedReserve(selected, ctx, options);
+    ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
     return selected;
   }
   if (callerMatchesObservedMain(selected)) assertMainAccountPolicy(options.config);
   assertMaterializedReserve(selected, ctx, options);
+  if (ctx.kind === "main") ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
   return selected;
 }

 export async function materializeCodexUpstreamAuthAsync(...): Promise<Headers> {
   ...
+  ctx.mainQuotaDispatch = undefined;   // ctx.kind === "main" in the substitution branch
   const selected = new Headers();
   ...
   observeSelectedMainCredential(stored, writer);
   assertMainAccountPolicy(options.config);
   assertMaterializedReserve(selected, ctx, options);
+  ctx.mainQuotaDispatch = selectedMainQuotaDispatch(selected);
   return selected;
 }
```

The proof is captured after every policy/reserve assertion, so a request that throws never
carries one. `captureConfigGeneration` and `extractAccountId` are already imported in
this file. `materializeReserveUpstreamAuth` reaches these through
`materializeCodexUpstreamAuthAsync`. The stored-main substitution path matches only when
`observeSelectedMainCredential` has recorded that credential (it does so on a live
writer); a stale writer yields no proof, which is the safe direction.

Check during build: the hard lock's "possible usage outside opencodex" advisory relies on
recent main-account activity through the proxy. Confirm caller-owned matched requests are
already recorded as activity (they pass `assertMainAccountPolicy`); if not, a fresh
header reading could be misread as outside usage — record the activity alongside the
write, or document the gap.

### `src/server/responses/core-codex-account.ts` (MODIFY)

```ts
/** Live proof that this plain-main response came back for the observed main credential. */
export function liveMainQuotaDispatch(
  authCtx: CodexAuthContext, provider: OcxProviderConfig,
): MainQuotaDispatch | undefined {
  if (authCtx.kind !== "main" || !authCtx.mainQuotaDispatch) return undefined;
  if (!isCanonicalOpenAiForwardProvider(provider)
    || provider.authMode !== "forward" || provider.adapter !== "openai-responses") return undefined;
  return isMainQuotaDispatchLive(authCtx.mainQuotaDispatch) ? authCtx.mainQuotaDispatch : undefined;
}
```

`codexWsQuotaObserver`: replace the single early return at `core-codex-account.ts:125`
(adding a branch below it would be unreachable). When the pool gate does not apply,
capture `liveMainQuotaDispatch(authCtx, provider)` once into the closure (never re-read
mutable `authCtx` per frame) and return an observer that re-checks
`isMainQuotaDispatchLive(dispatch)` per frame and then synchronously calls
`applyCapturedCodexQuota(MAIN_CODEX_ACCOUNT_ID, headers, dispatch.configGeneration,
dispatch.writer, { modelId })`.

The canonical-provider check matters: a custom `openai-responses` provider pointed at
another host must never write `__main__`.

### `src/server/responses/passthrough-delivery.ts` (MODIFY)

After the pool block:

```ts
} else {
  const mainDispatch = liveMainQuotaDispatch(admissionState.authCtx, route.provider);
  if (mainDispatch && !isCodexWsQuotaObservedResponse(upstreamResponse)) {
    const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
    // The import yields; a credential replaced meanwhile leaves the writer live
    // (quota.ts only checks identity), so re-check the dispatch proof with no await between.
    if (isMainQuotaDispatchLive(mainDispatch)) {
      applyAccountQuotaFromUpstreamHeaders(MAIN_CODEX_ACCOUNT_ID, upstreamResponse.headers,
        mainDispatch.configGeneration, mainDispatch.writer, { modelId: route.modelId });
    }
  }
}
```

Context identity (verified by the architect): initial materialization uses the context
returned at `core-auth.ts:303/340`, assigned unchanged at `request-prepare.ts:1387`;
account-retry materialization reaches the synchronous helper via
`core-codex-account.ts:752` and the new context replaces admission state at
`passthrough-dispatch.ts:1636`. The proof set during materialization is therefore the one
delivery reads. A second materialization at `core-auth.ts:314` re-captures it.

No auth-file read, refresh, affinity, rotation or quarantine is added for caller-owned
requests. A missing proof, a different bearer or workspace, a non-canonical provider or
absent quota headers records nothing.

### Tests

NEW `tests/responses/responses-main-quota-observation.test.ts` (register in both layout
files), using existing main-quota test seams from `tests/codex-integration/
main-quota-provenance.test.ts`:

1. observed main credential sent as caller bearer → HTTP response headers update
   `__main__`;
2. stored-main substitution → updates `__main__`;
3. caller bearer for a different account, or same account with a different token → no
   write;
4. main credential replaced between dispatch and response (credential generation bump) →
   no write; A→B→A identity change → no write;
5. non-canonical forward provider → no write;
6. WebSocket observer path for a matching main dispatch → updates once (no duplicate HTTP
   write when `isCodexWsQuotaObservedResponse`);
7. pool request behaviour unchanged;
8. credential replaced during the HTTP path's awaited import → no write;
9. WS: credential replaced between two frames → first frame writes, second does not;
10. same bearer with a different `chatgpt-account-id` workspace → no write;
11. quota headers: a non-numeric or absent set parses to nothing → no write. Out-of-range
    values follow the existing consumer contract shared with `main-pool`
    (`src/codex/quota.ts:620`): the display reading is clamped while
    `isInvalidPolicyUsagePercent` withholds policy evidence. Assert both halves (display
    clamped, `mainPolicyQuota` unchanged) and a mixed valid/invalid window case;
12. persistence: the serialized `codex-quota-cache.json` carries a fresh
    `quotas.__main__.updatedAt` and no dispatch proof or credential material;
13. pool→caller-main account retry (`core-codex-account.ts:752` path) records under the
    proof of the final dispatch only.

### Docs

- `structure/providers/openai-accounts.md`, `structure/providers/openai-tiers.md` and
  `structure/transports/responses.md`: plain-main responses record quota under the same
  credential-match rule as the hard lock; canonical provider only.
- `docs-site/src/content/docs/reference/cli/providers-accounts.md`, section
  "Main-account quota protection", after the paragraph ending "…cannot clear or set the
  current account's reauthentication state.": add
  "Responses to requests sent with the identified main credential refresh its cached
  usage from their quota headers, whether the proxy substituted the stored credential or
  the caller sent the same credential itself. A response is applied only if that
  credential is still the observed main credential when it arrives; a caller-owned
  credential for another account or workspace never updates the main account's usage."
  Translated locales are left to the translation sync.

Both work phases add one line to each layout manifest (`layout.json` at 1982 lines,
limit 2000); verify the combined result after the first PR lands.

## Verification

Focused: the new test file, `main-quota-provenance`, `main-quota-evidence-validation`,
`codex-auth-context`, `codex-pool-request-owned-main`, `tests/responses/ws-upstream.test.ts`;
`bun run typecheck`. Independent review plus a separate security review (credential
binding, misattribution, timing-safe comparison, no persisted credential material).

## Risks

Recording more main observations makes the hard lock react to live headers between WHAM
probes; that is the same data main-pool requests already feed it. If the reporter's
requests actually resolve to `main-pool`, this change does not explain their symptom and
the issue stays open with a request for a sampled request's resolved context.
