# 020 — wp3: classify intercepted Claude clients

## Goal and boundary

After wp2 supplies `cliFirstParty`, `ClaudeFirstPartyDesired`, and `firstPartyDesired`, route only the opted-in Claude client's Messages requests through the router. An opted-out client relays every path to real Anthropic; an opted-in client's other paths retain the configured upstream relay. IN: HTTPS-request User-Agent classification, listener route seam, runtime/lifecycle wiring, live Desktop-intent propagation, tests. OUT: settings reconciliation, API flag validation/refusals, CLI, GUI, docs, picker trust, CONNECT classification, and A1 Desktop-only egress. This phase must not change any contract in `000_plan.md`.

Build order: wp2 first; then classifier, listener, runtime, lifecycle, live-config propagation, tests, and the structure docs below. Run focused tests and typecheck after the implementation. `src/AGENTS.md:11` requires the owning structure docs in the same change, so wp3 updates `structure/runtime.md`, `structure/clients/claude-desktop.md` and `structure/gui-and-management-api.md` itself (see "Revision 2" and the paragraph at the end).

## File change map

| Path | Action | Purpose |
| --- | --- | --- |
| `src/claude/intercept/client-class.ts` | NEW | Parse the full external entrypoint; map UA and desired intent to `router`/`relay-native`. |
| `src/claude/intercept/listener.ts` | MODIFY | Evaluate the optional route callback on every request; send `relay-native` to real Anthropic before the existing Messages/non-Messages split. |
| `src/claude/intercept/runtime.ts` | MODIFY | Convert live desired callback and request UA into listener route. |
| `src/server/index/claude-intercept-lifecycle.ts` | MODIFY | Observe legacy Desktop mode once; close over the long-lived config object. |
| `src/server/management/native-integration-routes.ts` | MODIFY **scope expansion required** | Publish persisted Desktop intent/mode into that same live object after successful writes. Without this, native Desktop toggle leaves the callback stale. |
| `tests/claude-integration/claude-intercept-client-class.test.ts` | NEW | Full-shape parser, route/listener matrix, custom-upstream egress, header/body and incremental SSE/abort tests. |
| `tests/claude-integration/claude-desktop-picker-routes.test.ts` | MODIFY | Assert picker-port CONNECT reaches the same HTTPS classifier. |
| `tests/codex-integration/native-claude-desktop-toggle.test.ts` | MODIFY | Assert successful native toggle updates the live object. |
| `scripts/test-layout/layout.json` | MODIFY | Explicit new test ownership. |
| `tests/fixtures/test-layout-expected.json` | MODIFY | Expected new test ownership. |
| `structure/runtime.md` | MODIFY | Per-request classification and relay-native (paragraph in Revision 2) |
| `structure/clients/claude-desktop.md` | MODIFY | Independent intents share one env; opted-out client relays (Revision 2) |
| `structure/gui-and-management-api.md` | MODIFY | Native Desktop toggle publishes committed intent to the running config (paragraph below) |

`src/server/index/optional-listeners.ts` needs no edit: `src/server/index/optional-listeners.ts:82` says `activeConfig = ctx.config;`, and line 88 passes `config: ctx.config` into the lifecycle. Preserve that object identity. The **native route edit is beyond the originally named wp3 source list**; main must assign it to wp3 (recommended) or establish an equivalent live adoption before claiming native-toggle coverage.

## Exact edits

New file anchor: `src/claude/intercept/listener.ts:1` currently says `import type { Server } from "bun";`; put the new sibling beside it. It imports only wp2's type, so no runtime edge back to Desktop.

```diff
--- /dev/null
+++ b/src/claude/intercept/client-class.ts
@@
+import type { ClaudeFirstPartyDesired } from "../first-party-settings";
+
+export type InterceptClient = "desktop" | "cli" | "unknown";
+export const DESKTOP_ENTRYPOINTS = ["claude-desktop", "claude-desktop-3p", "local-agent"] as const;
+
+export function interceptEntrypoint(userAgent: string | null): string | null {
+  return userAgent?.match(/^claude-cli\/[^\s()]+ \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/)?.[1] ?? null;
+}
+
+export function classifyInterceptClient(userAgent: string | null): InterceptClient {
+  const entrypoint = interceptEntrypoint(userAgent);
+  if (entrypoint === null) return "unknown";
+  return (DESKTOP_ENTRYPOINTS as readonly string[]).includes(entrypoint) ? "desktop" : "cli";
+}
+
+export function interceptRouteFor(client: InterceptClient, desired: ClaudeFirstPartyDesired): "router" | "relay-native" {
+  return client !== "unknown" && desired[client] ? "router" : "relay-native";
+}
```

Listener anchor: `src/claude/intercept/listener.ts:15` defines `CLAUDE_INTERCEPT_UPSTREAM`; line 93 has `dispatch`, and line 113 starts the Messages split. Route every request before that split, using the constant for opted-out egress regardless of `upstreamBase`.

```diff
--- a/src/claude/intercept/listener.ts
+++ b/src/claude/intercept/listener.ts
@@
   dispatch: (req: Request, server: Server<T>) => Promise<Response>;
+  /** Per-request decision for every path; absent preserves the existing path split. */
+  route?: (req: Request) => "router" | "relay-native";
   upstreamBase?: string;
@@
       const url = new URL(req.url);
+      if (options.route?.(req) === "relay-native") {
+        return relayToUpstream(req, CLAUDE_INTERCEPT_UPSTREAM, options.fetchImpl);
+      }
       if (isClaudeInterceptedPath(url.pathname, req.method)) {
         return options.dispatch(rewriteInterceptedRequest(req, loopbackOrigin), requestServer);
       }
       return relayToUpstream(req, upstreamBase, options.fetchImpl);
```

Runtime anchor: `src/claude/intercept/runtime.ts:6` says `import { startClaudeInterceptListener } from "./listener";`; line 145 says `const listener = startClaudeInterceptListener<T>({`.

```diff
--- a/src/claude/intercept/runtime.ts
+++ b/src/claude/intercept/runtime.ts
@@
 import { startClaudeInterceptListener } from "./listener";
+import { classifyInterceptClient, interceptRouteFor } from "./client-class";
+import type { ClaudeFirstPartyDesired } from "../first-party-settings";
@@
   dispatch: (req: Request, server: Server<T>) => Promise<Response>;
+  /** Live first-party intent; absent preserves router behavior. */
+  desiredClients?: () => ClaudeFirstPartyDesired;
   maxRequestBodySize?: number;
@@
   const listener = startClaudeInterceptListener<T>({
     leaf,
     dispatch: options.dispatch,
+    ...(options.desiredClients ? { route: (req: Request) =>
+      interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), options.desiredClients!()) } : {}),
     upstreamBase: options.config.claudeCode?.anthropicBaseUrl,
```

Keep `desiredClients` absent for direct callers: `tests/claude-integration/claude-desktop-picker-routes.test.ts:72` calls `startClaudeIntercept` directly, and legacy router behavior must remain. The `!` is locally safe because the property is checked when the route closure is created; a builder-local `const desiredClients = options.desiredClients` is an equally valid implementation.

Lifecycle anchor: `src/server/index/claude-intercept-lifecycle.ts:49` says `start(options) {`; line 51 says `pending = startClaudeIntercept<T>({`.

```diff
--- a/src/server/index/claude-intercept-lifecycle.ts
+++ b/src/server/index/claude-intercept-lifecycle.ts
@@
 import type { PickerRouteInput } from "../../claude/intercept/picker-models";
+import { observeClaudeDesktopMode } from "../../claude/desktop-first-party";
+import { firstPartyDesired } from "../../claude/first-party-settings";
+import { claudeInterceptEnabled } from "../../claude/intercept/runtime";
@@
     start(options) {
       const dispatch = options.dispatch;
+      const observed = observeClaudeDesktopMode(options.config);
       pending = startClaudeIntercept<T>({
         ...options,
+        // A disabled Claude surface relays everything, even while the bound listener lives until restart (R3).
+        desiredClients: () => claudeInterceptEnabled(options.config)
+          ? firstPartyDesired(options.config, observed)
+          : { desktop: false, cli: false },
         loadPickerRoutes: options.loadPickerRoutes ?? loadPickerRoutesFromCatalog,
```

Import graph: `src/claude/desktop-first-party.ts:26` imports `./intercept/runtime`. This new edge goes from lifecycle to Desktop, never from runtime to Desktop. `client-class.ts` imports a type only. The existing runtime-to-picker-runtime edge and its dynamic Desktop mode import remain unchanged. The core Lab guard in `tests/lab/core-lab-boundary.test.ts:19-30` traverses `router.ts`, `server/lifecycle.ts`, `server/responses/core.ts`, and management API; this plan adds no edge from them to `src/lab`. Run that guard on the built wp3 tree; a passing pre-change run is not proof of the new graph.

Live-config anchor: `src/server/management/native-integration-routes.ts:702` says `const persisted = setIntegrationEnabled("claude-desktop", body.enabled);`; line 707 says `const current = loadConfig();`. The callback reads `options.config`, not `current`. The following is the minimal additional edit; update native-toggle tests to assert the same object changes only after persistence succeeds.

```diff
--- a/src/server/management/native-integration-routes.ts
+++ b/src/server/management/native-integration-routes.ts
@@
     const current = loadConfig();
+    // Publish committed Desktop intent to the long-lived server config used by intercept routing.
+    ctx.config.clientIntegrations = structuredClone(current.clientIntegrations);
     const fingerprint = current.claudeCode?.desktopProfile?.appliedFingerprint ?? null;
```

There is a second live-mode edge: `persistDesktopModeMarker` at native routes line 679 writes with `mutatePersistedConfig` but does not call `adoptPersistedClaudeCode`; line 771 invokes it. Carry the committed Claude subtree into the same live object, changing both line-758/771 callers:

```diff
--- a/src/server/management/native-integration-routes.ts
+++ b/src/server/management/native-integration-routes.ts
@@
-import { getConfigPath, loadConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode } from "../../config";
+import { adoptPersistedClaudeCode, getConfigPath, loadConfig, mutatePersistedConfig, saveConfigPreservingClaudeCode } from "../../config";
@@
-function persistDesktopModeMarker(desktopMode: ClaudeDesktopMode): boolean {
-  const outcome = mutatePersistedConfig(persisted => recordClaudeDesktopMode(persisted, desktopMode));
-  return outcome.status !== "unavailable";
+function persistDesktopModeMarker(config: ManagementContext["config"], desktopMode: ClaudeDesktopMode): boolean {
+  const outcome = mutatePersistedConfig(persisted => {
+    const result = recordClaudeDesktopMode(persisted, desktopMode);
+    return { changed: result.changed, value: structuredClone(persisted.claudeCode) };
+  });
+  if (outcome.status === "unavailable") return false;
+  adoptPersistedClaudeCode(config, outcome.value);
+  // The mode marker IS the committed transaction (same reason as desktop-gateway-state.ts:37-41):
+  // without an armed baseline the three-way adopt keeps a stale live desktopMode, so pin the leaf.
+  recordClaudeDesktopMode(config, desktopMode);
+  return true;
 }
@@
-          const partialModeWarning = !removed.ok && removed.changed && !persistDesktopModeMarker("first-party")
+          const partialModeWarning = !removed.ok && removed.changed && !persistDesktopModeMarker(ctx.config, "first-party")
@@
-        const modeSaved = persistDesktopModeMarker("first-party");
+        const modeSaved = persistDesktopModeMarker(ctx.config, "first-party");
```

`PUT /api/claude-code` currently mutates `config` with `commitClaudeCodeBlock(config, next)` at `agent-settings-routes.ts:1753`, then persists that same object at line 1755. wp4 must add `cliFirstParty` validation and transactional refusal without publishing an uncommitted `next`; after a successful write, the callback sees the new property on the same object. `mutatePersistedConfig` is the locked disk authority (`src/config/persisted-mutation.ts:37-92`); `adoptPersistedClaudeCode` updates the live Claude subtree and its baseline (`src/config/live-reconcile.ts:123-141`). The native Desktop `clientIntegrations` copy above is required because its `setIntegrationEnabled` persists on a separate object. Do not capture `config.claudeCode` or `config.clientIntegrations` as startup snapshots.

New test anchor: `tests/claude-integration/claude-intercept-proxy.test.ts:4` says `import { startClaudeInterceptListener, rewriteInterceptedRequest } from "../../src/claude/intercept/listener";`. Use its local CA and TLS-fetch pattern (`:56-85`, `:106-116`); `tests/helpers/repo-root.ts:27-46` supplies `repoPath` for any source-oracle read, though this test needs none.

```diff
--- /dev/null
+++ b/tests/claude-integration/claude-intercept-client-class.test.ts
@@
+import { expect, test } from "bun:test";
+import { classifyInterceptClient, interceptEntrypoint, interceptRouteFor } from "../../src/claude/intercept/client-class";
+import { startClaudeInterceptListener } from "../../src/claude/intercept/listener";
+import { createLocalInterceptCa, issueLocalInterceptLeaf } from "../../src/claude/intercept/local-ca";
+
+const samples: Array<[string | null, string | null, "desktop" | "cli" | "unknown"]> = [
+  ["claude-cli/2.1.282 (external, cli)", "cli", "cli"],
+  ["claude-cli/2.1.282 (external, sdk-cli)", "sdk-cli", "cli"],
+  ["claude-cli/2.1.282 (external, claude-vscode)", "claude-vscode", "cli"],
+  ["claude-cli/2.1.282 (external, claude-desktop)", "claude-desktop", "desktop"],
+  ["claude-cli/2.1.282 (external, claude-desktop-3p)", "claude-desktop-3p", "desktop"],
+  ["claude-cli/2.1.282 (external, local-agent)", "local-agent", "desktop"],
+  ["claude-cli/2.1.282 (external, cli, agent-sdk/0.3)", "cli", "cli"],
+  [null, null, "unknown"], ["Mozilla/5.0", null, "unknown"], ["garbage", null, "unknown"],
+  ["claude-cli/2.1.282 (external, cli, junk", null, "unknown"],
+  ["claude-cli/2.1.282 (external, cli)junk", null, "unknown"],
+  ["claude-cli/2.1.282 (external,cli)", null, "unknown"],
+  ["claude-cli/ (external, cli)", null, "unknown"],
+  [" claude-cli/2.1.282 (external, cli)", null, "unknown"],
+];
+test.each(samples)("entrypoint %s", (ua, entrypoint, client) => {
+  expect(interceptEntrypoint(ua)).toBe(entrypoint);
+  expect(classifyInterceptClient(ua)).toBe(client);
+});
+
+test("intent matrix routes only identified, desired clients", () => {
+  for (const desktop of [false, true]) for (const cli of [false, true]) {
+    for (const client of ["desktop", "cli", "unknown"] as const) {
+      expect(interceptRouteFor(client, { desktop, cli })).toBe(
+        client !== "unknown" && (client === "desktop" ? desktop : cli) ? "router" : "relay-native",
+      );
+    }
+  }
+});
+
+test("listener chooses router or relay by UA and live intent; relay preserves the request", async () => {
+  const ca = createLocalInterceptCa();
+  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
+  const dispatched: string[] = [];
+  const relayed: Array<{ url: string; method: string; body: string; authorization: string | null; anthropic: string | null }> = [];
+  let desired = { desktop: false, cli: true };
+  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
+    const headers = new Headers(init?.headers);
+    relayed.push({ url: String(input), method: init?.method ?? "", body: await new Response(init?.body).text(),
+      authorization: headers.get("authorization"), anthropic: headers.get("anthropic-version") });
+    return Response.json({ path: "relay" });
+  }) as typeof fetch;
+  const listener = startClaudeInterceptListener({ leaf, upstreamBase: "https://api.anthropic.com", fetchImpl: fakeFetch,
+    route: req => interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), desired),
+    dispatch: async req => { dispatched.push(new URL(req.url).pathname); return Response.json({ path: "router" }); } });
+  try {
+    for (const [ua, route] of [
+      ["claude-cli/2.1.282 (external, cli)", "router"],
+      ["claude-cli/2.1.282 (external, claude-desktop)", "relay"],
+      ["Mozilla/5.0", "relay"],
+    ] as const) {
+      const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages?x=1`, {
+        method: "POST", headers: { "user-agent": ua, authorization: "Bearer opaque", "anthropic-version": "2023-06-01" },
+        body: "opaque-body", tls: { ca: ca.certPem },
+      });
+      expect((await response.json() as { path: string }).path).toBe(route);
+    }
+    desired = { desktop: true, cli: false };
+    const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages/count_tokens`, {
+      method: "POST", headers: { "user-agent": "claude-cli/2.1.282 (external, claude-desktop-3p)" },
+      body: "{}", tls: { ca: ca.certPem },
+    });
+    expect((await response.json() as { path: string }).path).toBe("router");
+    expect(dispatched).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
+    expect(relayed).toEqual([
+      { url: "https://api.anthropic.com/v1/messages?x=1", method: "POST", body: "opaque-body", authorization: "Bearer opaque", anthropic: "2023-06-01" },
+      { url: "https://api.anthropic.com/v1/messages?x=1", method: "POST", body: "opaque-body", authorization: "Bearer opaque", anthropic: "2023-06-01" },
+    ]);
+    for (const desktop of [false, true]) for (const cli of [false, true]) {
+      desired = { desktop, cli };
+      for (const [ua, , client] of samples) for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
+        const headers = new Headers({ authorization: "Bearer matrix", "anthropic-version": "2023-06-01" });
+        if (ua !== null) headers.set("user-agent", ua);
+        const beforeRouter = dispatched.length;
+        const beforeRelay = relayed.length;
+        const result = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
+          method: "POST", headers, body: "matrix-body", tls: { ca: ca.certPem },
+        });
+        const expectedRoute = client !== "unknown" && (client === "desktop" ? desktop : cli) ? "router" : "relay-native";
+        expect((await result.json() as { path: string }).path).toBe(expectedRoute === "router" ? "router" : "relay");
+        expect(dispatched.length - beforeRouter).toBe(expectedRoute === "router" ? 1 : 0);
+        expect(relayed.length - beforeRelay).toBe(expectedRoute === "relay-native" ? 1 : 0);
+        if (expectedRoute === "relay-native") expect(relayed.at(-1)).toEqual({
+          url: `https://api.anthropic.com${path}`, method: "POST", body: "matrix-body",
+          authorization: "Bearer matrix", anthropic: "2023-06-01",
+        });
+      }
+    }
+    const beforeRouter = dispatched.length;
+    for (const [method, path] of [["GET", "/v1/messages"], ["POST", "/v1/models"]] as const) {
+      const result = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
+        method, tls: { ca: ca.certPem },
+      });
+      expect((await result.json() as { path: string }).path).toBe("relay");
+    }
+    expect(dispatched.length).toBe(beforeRouter);
+  } finally { await listener.stop(true); }
+});
```

The loop makes the listener matrix exhaustive for all listed UAs, four desired combinations, and both Messages paths. `tests/claude-integration/claude-intercept-proxy.test.ts:63` constructs the listener with no `route` and already asserts router, non-Messages relay, and GET relay at lines 117-146. Keep that regression.

The separate custom-upstream test makes the A1 egress destination observable for both Messages and non-Messages. Add these cases to the same new test file; the fake fetch prevents live network traffic.

```diff
--- a/tests/claude-integration/claude-intercept-client-class.test.ts
+++ b/tests/claude-integration/claude-intercept-client-class.test.ts
@@
+test("opted-out requests use real Anthropic on every path; opted-in other paths keep custom upstream", async () => {
+  const ca = createLocalInterceptCa();
+  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
+  const targets: string[] = [];
+  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
+    targets.push(String(input));
+    return Response.json({ via: "relay" });
+  }) as typeof fetch;
+  const listener = startClaudeInterceptListener({
+    leaf, upstreamBase: "https://custom.example", fetchImpl: fakeFetch,
+    route: req => interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), { desktop: false, cli: true }),
+    dispatch: async () => Response.json({ via: "router" }),
+  });
+  try {
+    for (const path of ["/v1/messages", "/v1/models"]) {
+      const response = await fetch(`https://127.0.0.1:${listener.port}${path}`, {
+        method: path === "/v1/messages" ? "POST" : "GET",
+        headers: { "user-agent": "claude-cli/2.1.282 (external, claude-desktop)" },
+        ...(path === "/v1/messages" ? { body: "{}" } : {}), tls: { ca: ca.certPem },
+      });
+      expect(await response.json()).toEqual({ via: "relay" });
+    }
+    const optedIn = await fetch(`https://127.0.0.1:${listener.port}/v1/models`, {
+      headers: { "user-agent": "claude-cli/2.1.282 (external, cli)" }, tls: { ca: ca.certPem },
+    });
+    expect(await optedIn.json()).toEqual({ via: "relay" });
+    expect(targets).toEqual([
+      "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1/models",
+      "https://custom.example/v1/models",
+    ]);
+  } finally { await listener.stop(true); }
+});

+test("native relay streams SSE incrementally and cancels upstream on client abort", async () => {
+  const ca = createLocalInterceptCa();
+  const leaf = issueLocalInterceptLeaf(ca, ["127.0.0.1"]);
+  const encoder = new TextEncoder();
+  const decoder = new TextDecoder();
+  let releaseSecond!: () => void;
+  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
+  let signalCancellation!: () => void;
+  const cancelled = new Promise<void>(resolve => { signalCancellation = resolve; });
+  let secondEnqueued = false;
+  let streamController!: ReadableStreamDefaultController<Uint8Array>;
+  const body = new ReadableStream<Uint8Array>({
+    start(controller) {
+      streamController = controller;
+      controller.enqueue(encoder.encode("event: first\ndata: 1\n\n"));
+    },
+    cancel() { signalCancellation(); },
+  });
+  const fakeFetch = (async () => {
+    void secondGate.then(async () => {
+      await Bun.sleep(25);
+      secondEnqueued = true;
+      streamController.enqueue(encoder.encode("event: second\ndata: 2\n\n"));
+    });
+    return new Response(body, { headers: { "content-type": "text/event-stream" } });
+  }) as typeof fetch;
+  const listener = startClaudeInterceptListener({
+    leaf, fetchImpl: fakeFetch, route: () => "relay-native",
+    dispatch: async () => Response.json({ via: "router" }),
+  });
+  try {
+    const abort = new AbortController();
+    const response = await fetch(`https://127.0.0.1:${listener.port}/v1/messages`, {
+      method: "POST", body: "{}", signal: abort.signal, tls: { ca: ca.certPem },
+    });
+    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
+    const reader = response.body!.getReader();
+    const first = await reader.read();
+    expect(decoder.decode(first.value)).toBe("event: first\ndata: 1\n\n");
+    expect(secondEnqueued).toBe(false); // observed before the producer can enqueue event two
+    releaseSecond();
+    const second = await reader.read();
+    expect(decoder.decode(second.value)).toBe("event: second\ndata: 2\n\n");
+    const pendingRead = reader.read();
+    abort.abort();
+    await Promise.race([cancelled, Bun.sleep(1000).then(() => { throw new Error("upstream stream was not cancelled"); })]);
+    await pendingRead.catch(() => undefined);
+  } finally { await listener.stop(true); }
+});
```

Picker test anchor: `tests/claude-integration/claude-desktop-picker-routes.test.ts:69` says `async function startPicker(saved: OcxConfig): Promise<number> {`; line 76 says `dispatch: async () => new Response("unused"),`. The existing `beforeEach`/`afterEach` at lines 102-115 owns the temp directory and handle teardown. Add the following test in that file:

```diff
--- a/tests/claude-integration/claude-desktop-picker-routes.test.ts
+++ b/tests/claude-integration/claude-desktop-picker-routes.test.ts
@@
-async function startPicker(saved: OcxConfig): Promise<number> {
+async function startPicker(saved: OcxConfig, onDispatch?: (req: Request) => Response): Promise<number> {
@@
-    dispatch: async () => new Response("unused"),
+    dispatch: async req => onDispatch?.(req) ?? new Response("unused"),
+    ...(onDispatch ? { desiredClients: () => ({ desktop: true, cli: false }) } : {}),
@@
 const decision = () => getClaudePickerRuntime()!.selectTunnel("claude.ai", 443);

+test("picker egress uses HTTPS Desktop entrypoint after a UA-less CONNECT", async () => {
+  const seen: string[] = [];
+  await startPicker(config(), req => {
+    seen.push(req.headers.get("user-agent") ?? "");
+    return Response.json({ via: "router" });
+  });
+  const result = await fetch("https://api.anthropic.com/v1/messages", {
+    method: "POST",
+    proxy: `http://127.0.0.1:${handle!.pickerProxyPort}`,
+    tls: { ca: readFileSync(handle!.caCertPath, "utf8") },
+    headers: { "user-agent": "claude-cli/2.1.282 (external, claude-desktop)", "anthropic-version": "2023-06-01" },
+    body: "{}",
+  });
+  expect(await result.json()).toEqual({ via: "router" });
+  expect(seen).toEqual(["claude-cli/2.1.282 (external, claude-desktop)"]);
+});
```

Native test anchor: `tests/codex-integration/native-claude-desktop-toggle.test.ts:36` says `async function dispatch(path: string, init?: RequestInit, deps: ManagementApiDeps = {}, inputConfig: OcxConfig = config()) {`; line 49 says `async function toggle(enabled: boolean, deps: ManagementApiDeps = {}) {`. The new test uses the same `inputConfig` identity across the management call and postcondition:

```diff
--- a/tests/codex-integration/native-claude-desktop-toggle.test.ts
+++ b/tests/codex-integration/native-claude-desktop-toggle.test.ts
@@
 async function toggle(enabled: boolean, deps: ManagementApiDeps = {}) {
@@
 }

+test("native Desktop OFF publishes committed intent to the running config", async () => {
+  const live = config();
+  const response = await dispatch("/api/native-integrations/claude-desktop", {
+    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
+  }, { removeDesktop3pStandardPivot: () => ({ ok: true, changed: false, kind: "noop", libraryPath: library }) }, live);
+  expect(response!.status).toBe(200);
+  expect(persistedIntent()).toBe(false);
+  expect(live.clientIntegrations?.["claude-desktop"]).toBe(false);
+});

+test("failed native Desktop intent write leaves the running config unchanged", async () => {
+  const live = config();
+  writeFileSync(join(root, "config.json"), "{");
+  const response = await dispatch("/api/native-integrations/claude-desktop", {
+    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
+  }, {}, live);
+  expect(response!.status).not.toBe(200);
+  expect(live.clientIntegrations).toBeUndefined();
+});
```

The invalid temp config is the failing `setIntegrationEnabled` precondition; it never touches the real home. No source file other than the listed two tests is required.

Layout anchors: `scripts/test-layout/layout.json:466` and `tests/fixtures/test-layout-expected.json:292` both say `"claude-intercept-proxy.test.ts": "claude-integration",`.

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@
     "claude-intercept-proxy.test.ts": "claude-integration",
+    "claude-intercept-client-class.test.ts": "claude-integration",
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@
   "claude-intercept-proxy.test.ts": "claude-integration",
+  "claude-intercept-client-class.test.ts": "claude-integration",
```

## PLAN-FIELD-CHAIN-01

| New value/field | Creation | Serialization | Deserialization | Every consumer |
| --- | --- | --- | --- | --- |
| `InterceptClient`: `desktop`, `cli`, `unknown` | `client-class.ts` classifier from request UA | N/A: request-local union; never persisted or emitted | N/A: parser creates it in memory | `client-class.ts` `interceptRouteFor`; test matrix |
| `ClaudeInterceptListenerOptions.route`: `router`/`relay-native` | `runtime.ts` closure; direct tests may supply it | N/A: function is not serializable | N/A: listener gets it by call | `listener.ts` evaluates it on every request; `relay-native` uses `CLAUDE_INTERCEPT_UPSTREAM` before the path split; `router`/absent keeps Messages dispatch and other-path `upstreamBase` relay |
| `StartClaudeInterceptOptions.desiredClients` | lifecycle callback over live config; direct callers may omit | N/A: process-local function | N/A: direct call argument | `runtime.ts` route construction, then classifier; absent preserves router |
| `ClaudeFirstPartyDesired.desktop/cli` | wp2 `firstPartyDesired` from `OcxConfig` and one observation | wp2 `cliFirstParty` / Desktop mode via config persistence; no new wp3 storage | wp2 config schema/load path; callback reads live config | `client-class.ts` route decision; lifecycle; listener result |

Search the enum type name, field name, all values, and `route`/`desiredClients` call sites in B; `rg -n 'InterceptClient|DESKTOP_ENTRYPOINTS|"unknown"|"desktop"|"cli"|route:|desiredClients|startClaudeInterceptListener|startClaudeIntercept\(' src tests/claude-integration` is the audit command. Unknown/malformed UA must relay regardless of intent. No default branch may silently turn it into CLI.

## Activation and assertions

The parser matrix activates each entrypoint family plus the five near-valid malformed spellings; each must return `unknown` and `relay-native`. The desired matrix exercises all four desktop/CLI combinations plus unknown. Listener cases exercise both Messages paths, route absent, `relay-native`, `router`, non-Messages and non-POST paths. A relay case proves exact method, body bytes, authorization and `anthropic-*` headers at `fetchImpl`; the existing `relayToUpstream` strips hop-by-hop headers, which is unchanged. The custom-upstream test proves opted-out Messages and non-Messages go to `CLAUDE_INTERCEPT_UPSTREAM`, while an opted-in non-Messages request uses `upstreamBase`. The SSE case proves content type, event order, first-event delivery before the second enqueue, and upstream cancellation on client abort. A fake-fetch rejection must still return the existing 502 (`listener.ts:67-82`). Live mutation after listener start must change the next request's route; native-toggle persistence failure must leave the previous route. Picker path must prove the TLS request UA decides, even when CONNECT lacks one.

## Verifiers actually run during planning

| Command | Exit | Reads wp3 target? |
| --- | --- | --- |
| `bun test tests/claude-integration/claude-intercept-proxy.test.ts` | Historical planning run: 1, missing `zod/v4` before test execution | Direct existing listener test argument; it did not execute assertions in that earlier run. |
| `bun test tests/lab/core-lab-boundary.test.ts` | Historical planning run: 1, missing `zod/v4` before test execution | Direct guard argument; it did not evaluate the new import graph in that earlier run. |
| `rg -n '"include": \["src"\]' tsconfig.json` | 0 | Confirms `tsconfig.json:15` includes future `src/` edits, not test files. |
| `rg -n 'claude-integration.*test\.ts|claude-intercept-proxy.test.ts' scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json` | 0 | Confirms current explicit test mapping; the future new file is not present yet. |
| `rg -n 'config\.claudeCode = next|commitClaudeCodeBlock\(config|saveConfigPreservingClaudeCode' src/server/management/agent-settings-routes.ts` | 0 | Reads live-config PUT anchors; does not execute wp3. |

After B, run `bun test tests/claude-integration/claude-intercept-client-class.test.ts tests/claude-integration/claude-intercept-proxy.test.ts tests/claude-integration/claude-desktop-picker-routes.test.ts tests/lab/core-lab-boundary.test.ts`, `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, and `bun run typecheck`. These are **future commands, not passing evidence**. `bun run typecheck` reads `src` via `tsconfig.json:15`; layout tests read the two explicit maps; the focused tests directly read changed runtime code. Review the planned Markdown manually: no code test reads this PRD.

## Risks, bypass, main questions

PLAN-BYPASS-NAMED-01: tier E4 (application route choice), executing surface `listener.ts` invoked by the local HTTPS listener, bypass path a local process can forge `User-Agent: claude-cli/... (external, cli)` (or bypass the proxy with `NO_PROXY=*`), residual risk opted-out requests can be made to route by a malicious local client. Wording is downgraded to **routing policy**, not a security boundary; final unbypassable layer: none. The shared settings env still sends opted-out clients through local TLS and requires the proxy running, per `000_plan.md` accepted limitation. Their requests relay to real Anthropic even when `anthropicBaseUrl` is customized. `relayToUpstream` may return 502 when upstream is unavailable; no silent native fallback.

Main must settle the native-route scope expansion and confirm wp4's transactional `PUT /api/claude-code` adoption before wp3 is called complete. It must also decide whether the parser accepts a valid but previously unseen external entrypoint as CLI (this document does, as the fixed `DESKTOP_ENTRYPOINTS` allowlist implies); any malformed UA remains unknown/relay. No live account, settings, CA, or proxy state is touched by this planning document.


## Revision 2 (reflection, main)

- R3: the lifecycle callback returns `{ desktop: false, cli: false }` when `claudeInterceptEnabled(options.config)`
  is false, so `claudeCode.enabled=false` or `intercept.enabled=false` relays every request to real Anthropic while the
  already-bound pair lives until restart. Test: in the lifecycle-level test (or a unit test of the callback
  factory extracted as `buildInterceptDesiredClients(config, observed)` in `claude-intercept-lifecycle.ts`),
  flip `config.claudeCode.enabled = false` on the live object after start and assert the next Desktop-UA and
  CLI-UA requests, including non-Messages, relay to `CLAUDE_INTERCEPT_UPSTREAM`.
- M1: this phase updates `structure/runtime.md` (Claude intercept pair section, anchor `structure/runtime.md:249-256`)
  with the paragraph below, and inserts after `structure/clients/claude-desktop.md:43` ("`api.anthropic.com` traffic
  reaches the [Claude intercept pair](../runtime.md#claude-intercept-pair).") this paragraph:

  > The Desktop and standalone CLI first-party switches are independent intents. They share only the owned
  > settings env; it remains while either intent is desired. A client whose intent is off may still traverse
  > that proxy, but every path relays to real Anthropic when its intent is off. The account-risk warning applies to either routed
  > first-party client.

  `structure/runtime.md` paragraph:

  > Requests on this ingress are classified per request from the Claude Code `User-Agent` entrypoint
  > (`src/claude/intercept/client-class.ts`): `claude-desktop`, `claude-desktop-3p` and `local-agent` are Desktop,
  > any other well-formed `claude-cli/<v> (external, <entrypoint>)` is the CLI, and a missing or malformed value is
  > unknown. Only a client whose first-party intent is on (Desktop mode, or `claudeCode.cliFirstParty`) enters the
  > router for Messages paths; other paths retain the configured upstream relay. Every path from an opted-out or
  > unknown client, and every path while the Claude surface is disabled, relays to real Anthropic through
  > `relayToUpstream` with `CLAUDE_INTERCEPT_UPSTREAM`. The split is a routing hint any local process can forge, not a trust boundary.

## Revision 5 (audit round 1)

This revision supersedes earlier wp3 routing and parser wording wherever it conflicts. A1: `interceptRouteFor` and the listener option return `"router" | "relay-native"`. Evaluate the callback for **every** HTTPS request. `relay-native` uses the fixed `CLAUDE_INTERCEPT_UPSTREAM` (`https://api.anthropic.com`) and ignores configured `claudeCode.anthropicBaseUrl`; `router` or an absent callback preserves the current Messages dispatch / other-path `upstreamBase` split. The exact edit, field chain, custom-upstream test and source-of-truth paragraphs above reflect that rule.

A4: the new SSE test uses a controlled 25 ms second-event delay. It checks `text/event-stream`, exact event bytes and order, first-event visibility while the second producer is blocked, and upstream stream cancellation after the client aborts. A7: `interceptEntrypoint` matches the anchored full shape `/^claude-cli\/[^\s()]+ \(external, ([A-Za-z0-9._-]+)(?:, [^,()]+)*\)$/`; the parser table includes missing close, trailing junk, missing comma space, empty version and leading space as unknown. These are executable acceptance cases, not permissive prefix matches.

Cross-phase audit handoff (A2, A3, A5, A6): superseded by Replan (000); the management and GUI contracts live in 030/040.

Revision 5 planning checks (no wp3 implementation exists yet): `bun -e` exercised the exact anchored regex against one valid suffix and all five malformed UAs (exit 0); `bun test tests/claude-integration/claude-intercept-proxy.test.ts` passed 15/15 existing listener tests (exit 0); `git diff --check -- devlog/_plan/260925_claude_cli_first_party/020_intercept_classification.md` passed (exit 0). The regex check reads the proposed expression; the existing test reads the current listener; only manual staged-diff review reads this Markdown plan. None is evidence that the future A1/A4 implementation passes.


## wp3 P amendment: structure/gui-and-management-api.md

Append to the native-integrations row/paragraph of `structure/gui-and-management-api.md` (the one naming
`PUT /api/native-integrations/claude-desktop`):

> After `PUT /api/native-integrations/claude-desktop` persists its intent, and whenever the Desktop mode marker is
> persisted, the route adopts the committed state into the running server config, because the Claude intercept's
> per-request first-party callback reads that live object; a failed write leaves it unchanged.


## wp3 A amendment (security audit): pin the committed Desktop mode on the live config

`persistDesktopModeMarker` now calls `recordClaudeDesktopMode(config, desktopMode)` after `adoptPersistedClaudeCode`
(diff above), mirroring `src/claude/desktop-gateway-state.ts:37-41`. File map addition:
`tests/claude-integration/claude-desktop-first-party.test.ts | MODIFY | native first-party ON pins the committed mode on a stale live config`.
That file already owns the first-party native fixtures (its `config()`, `dispatch(path, init, inputConfig)` and temp homes at
lines 31-60); the gateway-only `native-claude-desktop-toggle.test.ts` keeps the OFF-publication cases.

```diff
--- a/tests/claude-integration/claude-desktop-first-party.test.ts
+++ b/tests/claude-integration/claude-desktop-first-party.test.ts
`
 import { setIntegrationEnabled } from "../../src/codex/desired-state";
+import { firstPartyDesired } from "../../src/claude/first-party-settings";
` after the "native toggle: explicit first-party enable ..." test
+test("native first-party ON pins the committed mode on a stale live config", async () => {
+  // Disk says first-party (the route resolves the mode from loadConfig()); the running server still holds gateway.
+  writeFileSync(join(root, "config.json"), JSON.stringify(config({ claudeCode: { desktopMode: "first-party" } })));
+  const live = config({ claudeCode: { desktopMode: "gateway" } });
+  const enabled = await dispatch("/api/native-integrations/claude-desktop", { method: "PUT", body: JSON.stringify({ enabled: true }) }, live);
+  expect(enabled.status).toBe(200);
+  expect(enabled.body).toMatchObject({ ok: true, state: "current", desiredEnabled: true });
+  expect(live.claudeCode?.desktopMode).toBe("first-party");
+  expect(firstPartyDesired(live).desktop).toBe(true);
+});
```

## As built (fb4712a2d9)

- The lifecycle callback is the exported `buildInterceptDesiredClients(config, observed)` in
  `src/server/index/claude-intercept-lifecycle.ts`, so the disabled-surface relay is unit-testable without a bound
  listener; behaviour is the diff above.
- Bun normalizes leading whitespace in request header values, so the "leading space" malformed User-Agent case is
  covered only by the parser table in `tests/claude-integration/claude-intercept-client-class.test.ts`; the network
  matrix keeps every other case.
- Focused receipt before the no-local-suites directive: typecheck + 184 tests across 10 files, 0 fail.
