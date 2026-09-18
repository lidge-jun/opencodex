# Retire every OAuth callback response connection

Cycle callback; C4 auth transport. Independent of account pool features. Existing public #4280 is the change source; source read: `src/oauth/callback-server.ts:177`, `tests/oauth/oauth-callback-server.test.ts:1`. No-op leaves pooled connections reaching retired handlers; reuse the contributor patch rather than introduce a second listener implementation.

MODIFY `src/oauth/callback-server.ts`: add private `closingResponse(body, status, contentType = "text/html")`; both 404 and callback success/error return it. Before: ordinary Response headers contain only Content-Type, 404 has no explicit headers. After: each path includes `Connection: close`; state validation and graceful listener shutdown stay intact.
MODIFY `tests/oauth/oauth-callback-server.test.ts`: sequential fixed-port login and held-exchange favicon scenarios from #4280, with deterministic flow-publication barriers and cancellation cleanup rather than new polling sleeps.
MODIFY `structure/runtime.md`, `structure/transports/inventory.md`, `structure/providers/xai-grok.md`: carry the contributor's invariant and owner links. Public troubleshooting docs describe repeat login connection retirement if needed.

The exact reviewed public diff is reproduced below as the implementation contract. Credit: Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>. Retain latest source author commits in provenance; no original PR edits/closure.

```diff
diff --git a/src/oauth/callback-server.ts b/src/oauth/callback-server.ts
index dc49d5fcd2..2727f8362c 100644
--- a/src/oauth/callback-server.ts
+++ b/src/oauth/callback-server.ts
@@ -37,6 +37,27 @@ function errorHtml(message: string): string {

 export type CallbackResult = { code: string; state: string };

+/**
+ * Every response this listener sends ends its connection.
+ *
+ * The preferred callback port is FIXED per provider, so a later login listens on the same
+ * number — but a keep-alive socket stays bound to the flow that served it, and stopping that
+ * listener does not close an already-established connection. A client reusing the socket would
+ * hand the NEXT login's callback to the RETIRED flow, which rejects the unknown state as a CSRF
+ * mismatch while the live flow waits for a callback it can no longer receive.
+ *
+ * This is not limited to the callback itself: a browser that fetches `/favicon.ico` after the
+ * success page pools the socket on the 404, which is why the policy belongs to EVERY response
+ * rather than the callback path. Nothing here benefits from reuse — exactly one callback is
+ * expected per flow — so route every response through this helper.
+ */
+function closingResponse(body: string, status: number, contentType = "text/html"): Response {
+  return new Response(body, {
+    status,
+    headers: { "Content-Type": contentType, "Connection": "close" },
+  });
+}
+
 /**
  * The redirect URI advertised to providers must stay `localhost` (it is what the OAuth
  * apps have registered), but Windows commonly resolves `localhost` to `::1` first while
@@ -177,7 +198,7 @@ export abstract class OAuthCallbackFlow {
   #handleCallback(req: Request, expectedState: string): Response {
     const url = new URL(req.url);
     if (url.pathname !== this.callbackPath) {
-      return new Response("Not Found", { status: 404 });
+      return closingResponse("Not Found", 404, "text/plain");
     }

     const code = url.searchParams.get("code");
@@ -214,10 +235,7 @@ export abstract class OAuthCallbackFlow {
       });
     }

-    return new Response(ok ? SUCCESS_HTML : errorHtml(errMessage), {
-      status: ok ? 200 : consumeFlow ? 500 : 400,
-      headers: { "Content-Type": "text/html" },
-    });
+    return closingResponse(ok ? SUCCESS_HTML : errorHtml(errMessage), ok ? 200 : consumeFlow ? 500 : 400);
   }

   #waitForCallback(expectedState: string): Promise<CallbackResult> {
diff --git a/structure/providers/xai-grok.md b/structure/providers/xai-grok.md
index 765b85a763..16d1322412 100644
--- a/structure/providers/xai-grok.md
+++ b/structure/providers/xai-grok.md
@@ -15,6 +15,10 @@ Grounded in the open-sourced official client (xai-org/grok-build); unit + eviden
   `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
   zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
   detaches the credential to `source:"oauth"`.
+- **Browser login callback:** Grok's browser login uses the shared `OAuthCallbackFlow` listener
+  on a per-provider FIXED loopback port, so every response it sends closes its connection. A
+  retired flow that kept a pooled socket would capture the NEXT login's callback and reject it
+  as a state mismatch; see `src/oauth/callback-server.ts`.
 - **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
   exchange plus a short global store-write lock + async mutation funnel around every
   `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
diff --git a/structure/runtime.md b/structure/runtime.md
index 3099c13bfd..f31080646d 100644
--- a/structure/runtime.md
+++ b/structure/runtime.md
@@ -139,7 +139,7 @@ The server exposes `POST /api/stop` which restores native Codex config, stops an
 | --- | --- |
 | `src/providers/registry.ts` | Canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata. |
 | `src/providers/derive.ts` | Enrichment from provider presets into user config. |
-| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. |
+| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. |
 | `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
 | `src/adapters/openai-chat.ts` | OpenAI-compatible Chat Completions bridge. |
 | `src/adapters/anthropic.ts` | Anthropic Messages bridge. |
diff --git a/structure/transports/inventory.md b/structure/transports/inventory.md
index dc9af564d6..11cb227b01 100644
--- a/structure/transports/inventory.md
+++ b/structure/transports/inventory.md
@@ -20,6 +20,7 @@ surface is listed here so a maintainer can find the owner without grepping:
 | GitHub Copilot | `src/providers/xai-transport.ts` (`resolveProviderTransport`), `src/providers/github-copilot-transport.ts` | `resolveProviderTransport` selects the Copilot transport when the routed provider name is `github-copilot`; the Copilot module then resolves its headers and base URL, and the registry seeds the provider row and model fallback. |
 | API-key pools | `src/providers/api-key-selection.ts`, `src/providers/key-failover.ts` | A 429 rotates the active key and records a cooldown; `provider.apiKey` keeps mirroring the active entry so routing stays single-key. |
 | OAuth account failover | `src/oauth/generic-account-failover.ts`, `src/oauth/anthropic-routing.ts` | Reactive pre-output 429 recovery is presence-driven with 2+ eligible accounts. Pool and `oauthAccountFailover` flags govern proactive routing, not the reactive retry: a disabled Anthropic pool recovers through quota ordering rather than its dormant strategy, and a per-provider `enabled` beats the global default in either direction. |
+| OAuth login callback (inbound) | `src/oauth/callback-server.ts` | The only inbound transport this area owns: a short-lived loopback listener on a per-provider FIXED port. Exactly one callback is expected per flow, so EVERY response closes its connection — a retired flow must never keep a pooled socket that would capture the next login's callback. |
 | Alibaba regions | `src/providers/alibaba-region-backup.ts`, `src/providers/alibaba-region-migration.ts`, `src/providers/alibaba-region-startup.ts` | Region migration backs up before rewriting and is idempotent across restarts. |
 | Discovery and quota | `src/providers/model-discovery.ts`, `src/providers/quota.ts` | Discovery rejects a response over 4 MiB or past 2,000 raw rows before caching it. |

diff --git a/tests/oauth/oauth-callback-server.test.ts b/tests/oauth/oauth-callback-server.test.ts
index a327e1df0d..a46a2a04f3 100644
--- a/tests/oauth/oauth-callback-server.test.ts
+++ b/tests/oauth/oauth-callback-server.test.ts
@@ -29,6 +29,16 @@ class ManualFallbackFlow extends OAuthCallbackFlow {

 const ctrl: OAuthController = {};

+/** Keeps the listener alive across the token exchange so stray requests can reach it. */
+class SlowExchangeFlow extends ManualFallbackFlow {
+  holdExchange?: Promise<void>;
+
+  override async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
+    await this.holdExchange;
+    return super.exchangeToken(code, state, redirectUri);
+  }
+}
+
 describe("OAuth callback server defaults", () => {
   test("binds callback listeners to numeric loopback by default", () => {
     const flow = new TestFlow(ctrl, 54545, "/callback");
@@ -116,4 +126,103 @@ describe("OAuth callback server defaults", () => {
       blocker.stop(true);
     }
   });
+
+  test("a retired flow cannot serve the next login on the same callback port", async () => {
+    // The preferred callback port is fixed per provider, so consecutive logins listen on the
+    // same number. Stopping a listener does not close a connection that is already open, so a
+    // client that pools the socket would deliver the SECOND login's callback to the FIRST
+    // flow, which rejects the unknown state as a CSRF mismatch while the live flow waits.
+    const port = await freeLoopbackPort();
+    const options = {
+      preferredPort: port,
+      callbackPath: "/callback",
+      callbackHostname: "127.0.0.1",
+      callbackBindHostname: "127.0.0.1",
+    };
+    const deliver = async (state: string): Promise<number> => {
+      const url = new URL(`http://127.0.0.1:${port}/callback`);
+      url.searchParams.set("code", "authorization-code");
+      url.searchParams.set("state", state);
+      const res = await fetch(url);
+      await res.text();
+      return res.status;
+    };
+
+    const first = new ManualFallbackFlow(ctrl, options);
+    const firstLogin = first.login();
+    await waitForState(() => first.generated?.state);
+    const firstState = first.generated!.state;
+    expect(await deliver(firstState)).toBe(200);
+    await firstLogin;
+
+    const second = new ManualFallbackFlow(ctrl, options);
+    const secondLogin = second.login();
+    await waitForState(() => second.generated?.state);
+    const secondState = second.generated!.state;
+    expect(secondState).not.toBe(firstState);
+    // Served by the LIVE flow, so the retired state is now an unknown one.
+    expect(await deliver(firstState)).toBe(400);
+    expect(await deliver(secondState)).toBe(200);
+    await secondLogin;
+    expect(second.exchanged?.state).toBe(secondState);
+  });
+
+  test("a non-callback request cannot pin the socket to the retiring flow", async () => {
+    // A browser that asks for /favicon.ico after the success page would pool the socket on the
+    // 404 while exchangeToken() is still running, which re-pins it to the flow that is about to
+    // retire. The close policy therefore belongs to EVERY response, not just the callback path.
+    const port = await freeLoopbackPort();
+    const options = {
+      preferredPort: port,
+      callbackPath: "/callback",
+      callbackHostname: "127.0.0.1",
+      callbackBindHostname: "127.0.0.1",
+    };
+    const deliver = async (state: string): Promise<number> => {
+      const url = new URL(`http://127.0.0.1:${port}/callback`);
+      url.searchParams.set("code", "authorization-code");
+      url.searchParams.set("state", state);
+      const res = await fetch(url);
+      await res.text();
+      return res.status;
+    };
+
+    // The exchange is held open so the listener is still up for the stray request, which is
+    // exactly the window the reproduction describes.
+    const exchanging = Promise.withResolvers<void>();
+    const first = new SlowExchangeFlow(ctrl, options);
+    first.holdExchange = exchanging.promise;
+    const firstLogin = first.login();
+    await waitForState(() => first.generated?.state);
+    expect(await deliver(first.generated!.state)).toBe(200);
+    const favicon = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
+    await favicon.text();
+    expect(favicon.status).toBe(404);
+    exchanging.resolve();
+    await firstLogin;
+
+    const second = new ManualFallbackFlow(ctrl, options);
+    const secondLogin = second.login();
+    await waitForState(() => second.generated?.state);
+    // Without the close policy on the 404 this is answered by the retired flow and returns 400.
+    expect(await deliver(second.generated!.state)).toBe(200);
+    await secondLogin;
+    expect(second.exchanged?.state).toBe(second.generated!.state);
+  });
 });
+
+/** A port that is free right now; the flows bind it themselves, so it must not stay held. */
+async function freeLoopbackPort(): Promise<number> {
+  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, reusePort: false, fetch: () => new Response("probe") });
+  const { port } = probe;
+  probe.stop(true);
+  return port;
+}
+
+async function waitForState(read: () => string | undefined, timeoutMs = 5_000): Promise<void> {
+  const deadline = Date.now() + timeoutMs;
+  while (read() === undefined) {
+    if (Date.now() >= deadline) throw new Error("timed out waiting for the login flow to publish its state");
+    await Bun.sleep(5);
+  }
+}

```

Acceptance: first login succeeds, retired state is rejected by live listener (400), live state succeeds (200); favicon during held token exchange returns 404 without trapping the next flow. Failure/malformed callback paths close their connection too. Regression source is mandatory, local runtime execution NOT RUN. Hosted final-tip CI must cover oauth callback/bind and OrcaRouter provider suites. Security review checks unchanged state/PKCE, loopback destinations, no credential disclosure. Public code already describes the issue; additional security analysis goes to scratch only.

P stale check: whole contributor patch fails only at inventory table context because the API-key row changed. Selected source/test/runtime/xai hunks pass `git apply --check`. During B retain current inventory rows and append the new callback row after OAuth failover manually; do not overwrite current transport contracts.

Callback P revalidation after roadmap D: next direction is independent callback carry. Source hunks still apply; #4280 remains open at the same 1f826d92c head. Replace contributed polling helper with onAuth Promise.withResolvers readiness, AbortController deadline and finally cleanup settling held exchanges and login promises. Keep runtime Connection: close unconditional for both paths; no forced fetch header masks the defect. Shorten helper comment while preserving retirement rationale. Native role unavailable; inherited-model consultation is explicitly authorized. Product tests NOT RUN; source audit then remote CI.

Callback design ALIGNED (Lagrange) and independent A PASS (Leibniz): readiness resolves in onAuth queueMicrotask, login rejection rejects readiness; deadlines armed after handler registration; finally resolves held exchange, aborts flows, clears timers and settles login promises. Add response-only close-header checks alongside behavioral oracles.
