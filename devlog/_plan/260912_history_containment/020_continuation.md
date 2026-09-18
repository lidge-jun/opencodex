# Continuation source-pinned change design

Source: PR #4086 at 0c39bc60845211e1fe9efdeb8b34043fe4daac96. Initial carry uses the following public diff, revalidated against current dev at phase P. The current-tree map below is authoritative; fenced diff headers retain historical source provenance. Main resolves conflicts against current owners; no wholesale replacement from a stale head.

Before: current merge-base behavior in removed lines. After: added lines below. Tests are authored but NOT RUN locally; final-tip hosted CI observes these files. No new dependency or persisted schema is introduced by containment/continuation; relay owner state remains bounded/process-local and needs separate security review.

Activation: after final route selection, an unexpanded previous_response_id on selected openai-responses with explicit statelessResponses (any input kind), or unmapped lowered custom result; observe recoverable 400 and zero upstream calls, then complete-history retry and next incremental request. Capability creation comes from provider definitions/config, serialization uses existing provider config, deserialization existing loader, consumers selected core adapter guard; no new capability values.

Current-dev adaptation: old structure/04_transports-and-sidecars.md has been retired; transfer the continuation contract into structure/transports/responses.md and concise ownership links in mapped docs. Apply current source hunks, manually place the English guide addition beside continuation documentation while preserving newer text. This phase uses an independent dev branch; shared files alone create no dependency.

```diff
diff --git a/docs-site/src/content/docs/guides/codex-integration.md b/docs-site/src/content/docs/guides/codex-integration.md
index 5b75a21b41..368cbc5580 100644
--- a/docs-site/src/content/docs/guides/codex-integration.md
+++ b/docs-site/src/content/docs/guides/codex-integration.md
@@ -245,6 +245,15 @@ The cache remains bounded; this does not extend retention or recover history the
 longer has. HTTP clients must handle the error explicitly and resend their full context without
 `previous_response_id`. Retrying only the same ID cannot recover missing state.

+The same recovery signal applies to routed Responses providers configured with
+`statelessResponses: true`, and to routed requests when a custom tool is lowered to a
+function but a delta result has no local call to establish its original type. Full replay
+preserves the call, result, and reasoning together; opencodex does not guess the result type
+or discard it. Stateful providers can still resolve native function and native-only custom
+continuations themselves. These checks follow the selected wire protocol and tool catalog,
+not the model name. For gateways that cannot resolve stored response IDs, explicitly enable
+`statelessResponses` on that provider; this does not change other providers' defaults.
+
 ### Authless Codex Desktop (opt-in)

 In **Dashboard → Overview**, **Open Codex without signing in** controls this existing
diff --git a/docs-site/src/content/docs/ko/guides/codex-integration.md b/docs-site/src/content/docs/ko/guides/codex-integration.md
index ea7ff40cde..485ad39570 100644
--- a/docs-site/src/content/docs/ko/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ko/guides/codex-integration.md
@@ -128,6 +128,15 @@ upstream 요청 전에 `previous_response_not_found`를 반환합니다. Codex W
 `previous_response_id` 없이 전체 컨텍스트를 다시 보내야 합니다. 같은 ID만 재시도해서는
 누락된 상태를 복구할 수 없습니다.

+`statelessResponses: true`인 routed Responses provider에도 같은 복구 신호가 적용됩니다.
+또한 routed 경로에서 custom 도구를 function으로 변환하지만 증분 결과에 대응하는
+로컬 호출 기록이 없으면 전체 기록을 요청합니다. 호출, 결과, reasoning을 함께 재생하며
+결과 유형을 추측하거나 버리지 않습니다. 상태를 저장하는 provider의 네이티브 function 및
+네이티브 custom 전용 continuation은 그대로 전달됩니다. 이 검사는 모델명이 아니라 선택된
+wire protocol과 도구 선언을 따릅니다. 저장된 response ID를 복원하지 못하는 gateway에는
+해당 provider의 `statelessResponses`를 명시적으로 활성화하세요. 다른 provider의 기본값은
+바뀌지 않습니다.
+
 ## 스레드 식별자와 대화 기록

 기본 loopback 형식은 새 thread에 네이티브 `openai` provider 태그를 유지하므로 일반적인 resume history는 다시 매핑할 필요가 없습니다. sync와 restore는 일치하는 백업 manifest만 적용하여 각 thread의 원래 provider, source, event marker를 정확히 복원합니다. manifest가 없는 `opencodex` row는 변경하지 않으며, legacy 재태깅을 명시적으로 강제하려는 경우에만 `ocx recover-history --legacy-openai --yes`를 사용합니다. 이 명령은 의도적으로 범위가 넓습니다. 사용자 메시지가 있고 현재 `opencodex`로 표시된 모든 thread를 `openai`로 바꾸고, `exec`를 `cli`로 정규화하며 event marker를 설정합니다. 정상적인 dedicated-provider history도 포함됩니다. 상태를 백업하고 이 전체 범위를 의도한 경우에만 사용하세요. non-loopback 전용 provider 모드는 활성 상태일 때만 history를 `opencodex` provider 아래로 미러링하고, 종료할 때는 백업된 메타데이터를 복원합니다. history를 건드리지 않으려면 `syncResumeHistory: false`로 설정하세요.
diff --git a/docs-site/src/content/docs/reference/configuration/providers.md b/docs-site/src/content/docs/reference/configuration/providers.md
index f7e8f16abe..f2b73c822f 100644
--- a/docs-site/src/content/docs/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/reference/configuration/providers.md
@@ -938,7 +938,8 @@ representation returned to the client, including the visible content-to-summary
 echoing full history with `previous_response_id` does not duplicate that history. Hidden-summary
 requests and opaque reasoning blobs retain their existing representation. Cache hits can also
 supply earlier history for delta continuations;
-after a cache miss, resend the complete conversation without `previous_response_id`. Stateless
+after a cache miss, the proxy returns `previous_response_not_found` before upstream dispatch so
+the client can resend the complete conversation without `previous_response_id`. Stateless
 repair labels orphan results and missing tool results; it cannot reconstruct lost history or
 prove whether a missing tool execution succeeded.

diff --git a/src/responses/custom-tool-compat.ts b/src/responses/custom-tool-compat.ts
index ce8f9591d1..3577a23256 100644
--- a/src/responses/custom-tool-compat.ts
+++ b/src/responses/custom-tool-compat.ts
@@ -261,6 +261,29 @@ export function rewriteRoutedCustomToolsForUpstream(
   return { body: rewriteForUpstream(body, conversionNames, callIds), names, repairNames };
 }

+/**
+ * A delta result has no tool name. Without its call, lowering cannot tell whether it belongs
+ * to a converted function or a native custom tool. Request full replay instead of guessing.
+ */
+export function hasUnmappedRoutedCustomToolOutput(
+  body: unknown,
+  supportsResponsesCustomTools?: boolean,
+): boolean {
+  if (!isPlainObject(body) || !Array.isArray(body.input)) return false;
+  if (collectRoutedCustomToolNames(body, supportsResponsesCustomTools).size === 0) return false;
+  const callIds = new Set<string>();
+  for (const item of body.input) {
+    if (isPlainObject(item)
+      && (item.type === "custom_tool_call" || item.type === "function_call")
+      && typeof item.call_id === "string") callIds.add(item.call_id);
+  }
+  return body.input.some(item => isPlainObject(item)
+    && item.type === "custom_tool_call_output"
+    && typeof item.call_id === "string"
+    && item.call_id.length > 0
+    && !callIds.has(item.call_id));
+}
+
 export function restoreRoutedCustomCalls(
   value: unknown,
   names: ReadonlySet<string>,
diff --git a/src/server/responses/core.ts b/src/server/responses/core.ts
index b961e7cef9..c2b4a92469 100644
--- a/src/server/responses/core.ts
+++ b/src/server/responses/core.ts
@@ -394,7 +394,7 @@ import {
   payloadRewriteAsBlockRewrite,
   relaySseWithBlockRewrite,
 } from "../sse-payload-rewrite";
-import { restoreRoutedCustomCalls, restoreRoutedCustomCallsInJson } from "../../responses/custom-tool-compat";
+import { hasUnmappedRoutedCustomToolOutput, restoreRoutedCustomCalls, restoreRoutedCustomCallsInJson } from "../../responses/custom-tool-compat";
 import { createRoutedCustomToolRestoreBlockRewrite } from "../responses-custom-tool-repair";
 import { collectFunctionCallRepairSchemas, repairFunctionCallsInJson } from "../../responses/function-call-compat";
 import { createResponsesFunctionToolRepairBlockRewrite } from "../responses-function-tool-repair";
@@ -3673,6 +3673,22 @@ async function handleResponsesInner(
     );
   }

+  if (hasUnexpandedPreviousResponse) {
+    const continuationProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire);
+    // Stateless destinations cannot resolve the omitted prefix. Stateful destinations may,
+    // but a lowered custom result still needs its call to recover the original wire type.
+    // Native function/custom continuations without lowering keep their upstream-owned state.
+    if (continuationProvider.adapter === "openai-responses"
+      && (continuationProvider.statelessResponses === true
+        || hasUnmappedRoutedCustomToolOutput(parsed._rawBody, continuationProvider.supportsResponsesCustomTools))) {
+      return formatErrorResponse(
+        400,
+        "previous_response_not_found",
+        "Routed continuation requires unavailable local history; resend the full conversation without previous_response_id.",
+      );
+    }
+  }
+
   // Captured before normalization: whether the CLIENT asked for SSE. The
   // transport-neutral upstream-streaming policy below may force a bounded JSON
   // upstream for reliability (#875); the answer must then be reframed to SSE
diff --git a/src/types/provider.ts b/src/types/provider.ts
index b51230d6d1..feae0898ce 100644
--- a/src/types/provider.ts
+++ b/src/types/provider.ts
@@ -230,8 +230,8 @@ export interface OcxProviderConfig {
   /**
    * Responses upstream that stores nothing server-side (DeepSeek documents "the API
    * is stateless"). Stateful request parameters are dropped, `store` is pinned false,
-   * and orphaned tool results left by a replay miss are repaired rather than
-   * forwarded to an upstream that cannot resolve their pair.
+   * and missing local continuation history returns previous_response_not_found so
+   * clients can resend full input. Explicit input still receives orphan-item repair.
    */
   statelessResponses?: boolean;
   /**
diff --git a/structure/04_transports-and-sidecars.md b/structure/04_transports-and-sidecars.md
index c98c837cec..fc0634da8b 100644
--- a/structure/04_transports-and-sidecars.md
+++ b/structure/04_transports-and-sidecars.md
@@ -413,7 +413,10 @@ logic fills absent values and preserves explicit false; renamed custom configura
 no new destination-based migration. The existing stateless pass sets `store: false`, removes
 stored continuation parameters, and repairs orphan calls/results without claiming execution
 success. A local replay-cache hit supplies history; a miss cannot reconstruct it, so callers
-must resend complete history without `previous_response_id`. This flag also enables the existing
+receive `previous_response_not_found` before upstream dispatch and must resend complete history
+without `previous_response_id`. Routed custom-tool lowering also requires this recovery when a
+delta result lacks its call and the original wire type cannot be established. Stateful native
+function and native-only custom continuations retain upstream-owned resolution. This flag also enables the existing
 visible content-to-summary rewrite for SSE and JSON; summary-channel items and opaque reasoning
 blobs keep their existing response handling. The shared recording callback applies the same
 reasoning rewrite under the exact client-visible predicate before caching output, after tool
diff --git a/tests/codex-integration/issue-702-expired-replay-state.test.ts b/tests/codex-integration/issue-702-expired-replay-state.test.ts
index 13b96be638..1a9b3bd092 100644
--- a/tests/codex-integration/issue-702-expired-replay-state.test.ts
+++ b/tests/codex-integration/issue-702-expired-replay-state.test.ts
@@ -286,6 +286,126 @@ afterEach(() => {
   else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
 });

+describe("routed replay recovery", () => {
+  test.each([
+    { stateless: true, custom: false, expired: false },
+    { stateless: true, custom: false, expired: true },
+    { stateless: false, custom: true, expired: false },
+    { stateless: false, custom: true, expired: true },
+    { stateless: false, custom: true, expired: false, authMode: "forward" },
+    { stateless: true, custom: false, expired: false, adapter: "openai-chat" },
+  ] as const)("recovers missing history without orphaning tool results: %j", async scenario => {
+    const { stateless, custom, expired } = scenario;
+    const upstreamRequests: Record<string, unknown>[] = [];
+    const realNow = Date.now;
+    const toolCall = custom
+      ? { type: "custom_tool_call", call_id: "call_replay", name: "exec", input: "text(1)", status: "completed" }
+      : { type: "function_call", call_id: "call_replay", name: "lookup", arguments: "{}", status: "completed" };
+    const toolResult = {
+      type: custom ? "custom_tool_call_output" : "function_call_output",
+      call_id: "call_replay", output: "1",
+    };
+    const reasoning = { type: "reasoning", content: [{ type: "reasoning_text", text: "Use the lookup result." }] };
+    const history = [inputMessage(HISTORICAL_USER_SENTINEL), reasoning, toolCall];
+    const tools = custom
+      ? [{ type: "custom", name: "exec", description: "Run JavaScript", format: { type: "text" } }]
+      : [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
+    const upstream = Bun.serve({
+      port: 0,
+      async fetch(request) {
+        const body = await request.json() as Record<string, unknown>;
+        upstreamRequests.push(body);
+        const items = body.input as Array<Record<string, unknown>>;
+        // A strict upstream cannot resolve a tool result without its matching function call.
+        if (!items.some(item => item.type === "function_call" && item.call_id === "call_replay")
+          || !items.some(item => item.type === "function_call_output" && item.call_id === "call_replay")) {
+          return Response.json({ error: { type: "invalid_request_error", message: "No matching tool call" } }, { status: 400 });
+        }
+        return new Response(completedSse("resp_routed_recovered", "recovered"), {
+          headers: { "content-type": "text/event-stream" },
+        });
+      },
+    });
+    let server: ReturnType<typeof startServer> | null = null;
+    let socket: WebSocket | null = null;
+    try {
+      if (expired) {
+        Date.now = () => realNow() - EXPIRED_AGE_MS;
+        rememberResponseState(
+          { input: [history[0]], tools, store: false },
+          { id: FIRST_RESPONSE_ID, status: "completed", output: [reasoning, toolCall] },
+          undefined, { force: true },
+        );
+        Date.now = realNow;
+      }
+      saveConfig({
+        port: 0, hostname: "127.0.0.1", websockets: true, defaultProvider: "routed-test",
+        providers: {
+          "routed-test": {
+            adapter: "adapter" in scenario ? scenario.adapter : "openai-responses",
+            modelAdapters: { "test-model": "openai-responses" },
+            baseUrl: upstream.url.toString(), allowPrivateNetwork: true,
+            authMode: "authMode" in scenario ? scenario.authMode : "key", apiKey: "synthetic-key", defaultModel: "test-model",
+            statelessResponses: stateless, preserveResponsesReasoningContent: true,
+          },
+        },
+      } as OcxConfig);
+      server = startServer(0);
+      const deltaRequest = {
+        model: "routed-test/test-model", previous_response_id: FIRST_RESPONSE_ID,
+        input: [toolResult], tools, store: false,
+      };
+      const httpRejected = await originalFetch(new URL("/v1/responses", server.url), {
+        method: "POST", headers: { "content-type": "application/json" },
+        body: JSON.stringify(deltaRequest),
+      });
+      expect(httpRejected.status).toBe(400);
+      expect(await httpRejected.json()).toMatchObject({ error: { code: "previous_response_not_found" } });
+      expect(upstreamRequests).toHaveLength(0);
+      socket = await openResponseSocket(server.url, {});
+      const rejected = await sendSocketTurn(socket, deltaRequest);
+      expect(rejected).toMatchObject({
+        type: "error", status: 400,
+        error: { type: "invalid_request_error", code: "previous_response_not_found" },
+      });
+      expect(upstreamRequests).toHaveLength(0);
+
+      socket.close();
+      socket = await openResponseSocket(server.url, {});
+      const recovered = await sendSocketTurn(socket, {
+        model: "routed-test/test-model", input: [...history, toolResult], tools, store: false,
+      });
+      expect(recovered.type).toBe("response.completed");
+      expect(upstreamRequests).toHaveLength(1);
+      expect(upstreamRequests[0]!.previous_response_id).toBeUndefined();
+      expect(upstreamRequests[0]!.input).toEqual([
+        history[0], reasoning,
+        { type: "function_call", call_id: "call_replay", name: custom ? "exec" : "lookup",
+          arguments: custom ? JSON.stringify({ input: "text(1)" }) : "{}", status: "completed" },
+        { ...toolResult, type: "function_call_output" },
+      ]);
+      await waitForRecordedResponseState();
+
+      // Recovery must seed complete local history so the next delta does not repeat the miss.
+      const continued = await sendSocketTurn(socket, {
+        model: "routed-test/test-model", previous_response_id: "resp_routed_recovered",
+        input: [inputMessage(CURRENT_USER_SENTINEL)], tools, store: false,
+      });
+      expect(continued.type).toBe("response.completed");
+      expect(upstreamRequests).toHaveLength(2);
+      expect(upstreamRequests[1]!.previous_response_id).toBeUndefined();
+      const items = upstreamRequests[1]!.input as Array<Record<string, unknown>>;
+      expect(items.filter(item => item.call_id === "call_replay")).toHaveLength(2);
+      expect(items.at(-1)).toEqual(inputMessage(CURRENT_USER_SENTINEL));
+    } finally {
+      Date.now = realNow;
+      socket?.close();
+      await server?.stop(true);
+      await upstream.stop(true);
+    }
+  }, SERVER_BUDGET_MS);
+});
+
 describe("Issue #702 expired forward replay state", () => {
   test("known continuation spill failure returns terminal structured previous_response_not_found before upstream I/O", async () => {
     const responseId = "resp_issue_702_missing_spill";
@@ -512,7 +632,7 @@ describe("Issue #702 expired forward replay state", () => {
     expect(JSON.stringify(scenario.upstreamRequests[0]!.body)).toContain(HISTORICAL_USER_SENTINEL);
   });

-  test("API-key Responses providers can still forward native previous_response_id state", async () => {
+  test.each(["message", "function", "custom"] as const)("API-key Responses providers can still forward native %s continuation state", async kind => {
     const upstreamRequests: Record<string, unknown>[] = [];
     const realNow = Date.now;
     let upstream: ReturnType<typeof Bun.serve> | null = null;
@@ -539,6 +659,7 @@ describe("Issue #702 expired forward replay state", () => {
             allowPrivateNetwork: true,
             apiKey: "provider-key",
             defaultModel: "gpt-5.5",
+            statelessResponses: false,
           },
         },
       } as OcxConfig);
@@ -551,6 +672,12 @@ describe("Issue #702 expired forward replay state", () => {
           model: "test-openai/gpt-5.5",
           previous_response_id: "resp_upstream_native_state",
           input: [inputMessage(CURRENT_USER_SENTINEL)],
+          ...(kind === "message" ? {} : {
+            tools: [kind === "custom"
+              ? { type: "custom", name: "apply_patch", description: "Apply patch", format: { type: "text" } }
+              : { type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
+            input: [{ type: kind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: "call_native", output: "done" }],
+          }),
           stream: true,
         }),
       });
@@ -558,6 +685,9 @@ describe("Issue #702 expired forward replay state", () => {
       await response.text();
       expect(upstreamRequests).toHaveLength(1);
       expect(upstreamRequests[0]!.previous_response_id).toBe("resp_upstream_native_state");
+      if (kind !== "message") expect(upstreamRequests[0]!.input).toEqual([
+        { type: kind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: "call_native", output: "done" },
+      ]);
     } finally {
       Date.now = realNow;
       globalThis.fetch = originalFetch;
diff --git a/tests/responses/custom-tool-compat.test.ts b/tests/responses/custom-tool-compat.test.ts
index 530238c499..adfb2105c0 100644
--- a/tests/responses/custom-tool-compat.test.ts
+++ b/tests/responses/custom-tool-compat.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, test } from "bun:test";
-import { rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";
+import { hasUnmappedRoutedCustomToolOutput, rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";

 function convertedInputDescription(name: string): string | undefined {
   const result = rewriteRoutedCustomToolsForUpstream({
@@ -14,6 +14,51 @@ function convertedInputDescription(name: string): string | undefined {
 }

 describe("routed custom-tool compatibility", () => {
+  test("requires replay for ambiguous delta results without guessing their native or lowered type", () => {
+    const exec = { type: "custom", name: "exec", description: "Run JavaScript" };
+    const patch = { type: "custom", name: "apply_patch", description: "Apply a patch" };
+    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
+    const body = { tools: [exec, patch], input: [result] };
+    expect(hasUnmappedRoutedCustomToolOutput(body)).toBe(true);
+    expect(body.input).toEqual([result]);
+    // A native patch result with its known call remains native, even with exec declared.
+    const knownPatch = { ...body, input: [
+      { type: "custom_tool_call", name: "apply_patch", call_id: "call_sample", input: "patch" }, result,
+    ] };
+    expect(hasUnmappedRoutedCustomToolOutput(knownPatch)).toBe(false);
+    expect((rewriteRoutedCustomToolsForUpstream(knownPatch).body as typeof knownPatch).input[1]).toEqual(result);
+    // A complete lowered call/result pair can use the existing lossless conversion.
+    const knownExec = { ...body, input: [
+      { type: "custom_tool_call", name: "exec", call_id: "call_sample", input: "text(1)" }, result,
+    ] };
+    expect(hasUnmappedRoutedCustomToolOutput(knownExec)).toBe(false);
+    expect((rewriteRoutedCustomToolsForUpstream(knownExec).body as typeof knownExec).input[1]!.type).toBe("function_call_output");
+  });
+
+  test("preserves native-only continuations and follows explicit custom-tool lowering", () => {
+    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
+    const patchOnly = { tools: [{ type: "custom", name: "apply_patch" }], input: [result] };
+    expect(hasUnmappedRoutedCustomToolOutput(patchOnly)).toBe(false);
+    expect(hasUnmappedRoutedCustomToolOutput(patchOnly, true)).toBe(false);
+    expect(hasUnmappedRoutedCustomToolOutput(patchOnly, false)).toBe(true);
+    expect(hasUnmappedRoutedCustomToolOutput({ input: [result] })).toBe(false);
+    expect(hasUnmappedRoutedCustomToolOutput({
+      tools: [{ type: "custom", name: "exec" }],
+      input: [{ ...result, type: "function_call_output" }],
+    })).toBe(false);
+  });
+
+  test("detects lowered results when the current catalog is nested or supplied by additional_tools", () => {
+    const result = { type: "custom_tool_call_output", call_id: "call_sample", output: "done" };
+    const tool = { type: "custom", name: "exec", description: "Run JavaScript" };
+    expect(hasUnmappedRoutedCustomToolOutput({
+      tools: [{ type: "namespace", name: "functions", tools: [tool] }], input: [result],
+    })).toBe(true);
+    expect(hasUnmappedRoutedCustomToolOutput({
+      input: [{ type: "additional_tools", tools: [tool] }, result],
+    })).toBe(true);
+  });
+
   test.each([
     ["absent", undefined],
     ["true", true],
```

## Current-tree map and reflection

D1/D2/D3 accepted ALIGNED. Baseline d8df1b1064a846ecfff0d924e9395a1c16bf3504; historical source-PR parent differs. MODIFY src/responses/custom-tool-compat.ts, src/server/responses/core.ts, src/types/provider.ts and both existing test files from the pinned diff; English/Korean integration guides and providers.md receive the same pending contract. No new files.

MODIFY structure/transports/responses.md as primary contract. Add concise ownership links in runtime.md, catalog.md, subagents.md, adapters/registry.md, transports/streaming-health.md, transports/inventory.md, data-planes/images.md, data-planes/inbound-compat.md, providers/kiro.md, providers/xai-grok.md, providers/chat-compat.md, gui-and-management-api.md, clients/claude-desktop.md, ops/service-and-sidecars.md and ops/docs-and-release.md. Do not recreate structure/04_transports-and-sidecars.md or edit generated INDEX.md.
