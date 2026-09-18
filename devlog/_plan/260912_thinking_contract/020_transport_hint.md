# Optional hint suppression

Class C4 review because client metadata policy changes. Independent of presentation; depends only on roadmap. Adopt #3652 only after independent security/transport review. Public proposal removes exactly two x-codex-safety-buffering headers, metadata.type=safety_buffering events and top-level safety_buffering fields at the client relay boundary. Default false; malformed config must remain off and candidate validation rejects nonbooleans. This suppresses optional transport hints; provider safety decisions/refusals and upstream checks are unchanged. Compact and independent WS/other-provider pathways retain existing policy unless a directly exercised shared boundary already applies.

MODIFY src/config.ts and src/types/config.ts for validated boolean/default; src/server/relay.ts for allowlisted header removal and SSE terminal-boundary transformation; relay-eager.ts for option forwarding; core.ts to compute option only for canonical OpenAI forward destination and pass it to all relevant headers/client output boundaries; index.ts exports if needed by existing test style. Do not apply to custom gateway/key providers. Preserve errors, response.failed/incomplete and terminal sentinel handling.

MODIFY tests/responses/passthrough-headers.test.ts, openai-responses-passthrough.test.ts and tests/server/config.test.ts. Scenarios: absent/false/true/malformed config; uppercase headers; unrelated headers; split metadata frames; actual failure carrying hint must still fail; noncanonical provider has identical fields and retains them; eager/non-eager client paths. Add missing canonical route coverage if independent review identifies it. MODIFY English/ja/ko/ru/zh-cn server configuration docs and structure owners. Avoid unsupported claims about models being weaker or provider safety bypass.

Before/after anchor: createSseTerminalOutputBoundary() -> createSseTerminalOutputBoundary(options?: CodexSafetyBufferingFilterOptions); sanitizePassthroughHeaders(upstream) -> sanitizePassthroughHeaders(upstream, options?); canonical true => filter option, every other provider => undefined. Full public source diff is pinned by #3652 head in 000_plan.md and inspected locally; any needed correction is recorded here before B.

## Independent design corrections

H1 accepted: policy rewrite and hint stripping compose. Build policyFailurePayload first, then remove top-level safety_buffering from the effective emitted payload, preserving response.failed/error data and retryable:false. H2 accepted: extend current relaySseWithFailedTail fourth options object with terminalBoundary; never replace upstreamError. Core passes both existing upstreamError and new terminalBoundary; update the existing source-contract assertion to preserve its original guarantee. H3 accepted: native WebSocket codex.response.metadata.headers and /responses/compact are explicitly excluded; their hints remain unfiltered. No new WS metadata filter. Docs must not claim the old WS allowlist excludes these headers. Regression fixtures cover CRLF/split/malformed input, policy error plus hint, EOF upstreamError, canonical true and noncanonical preservation.

## Pinned source hunks (apply with corrections above)

```diff
diff --git a/src/config.ts b/src/config.ts
index fdcda9547c..cd0641feb2 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1125,6 +1125,8 @@ const configSchema = z.object({
   configRebaseProvenance: z.unknown().optional(),
   // A retry can be billable, so absence and malformed hand edits both stay off.
   emptyCompletionRetry: z.boolean().optional().catch(false),
+  // Header suppression changes what Codex sees, so absence and malformed edits stay off.
+  dropCodexSafetyBuffering: z.boolean().optional().catch(false),
   // A malformed hand edit must not silently stop opening the browser: fall back
   // to undefined, which resolves to the historical auto-open behavior.
   oauthOpenBrowser: z.boolean().optional().catch(undefined),
@@ -2613,6 +2615,14 @@ function emptyCompletionRetryError(value: unknown): string | null {
   return "schema_invalid: emptyCompletionRetry: must be a boolean or omitted";
 }

+function dropCodexSafetyBufferingError(value: unknown): string | null {
+  const raw = rawConfigRecord(value);
+  if (!raw || !Object.hasOwn(raw, "dropCodexSafetyBuffering")) return null;
+  const enabled = raw.dropCodexSafetyBuffering;
+  if (enabled === undefined || typeof enabled === "boolean") return null;
+  return "schema_invalid: dropCodexSafetyBuffering: must be a boolean or omitted";
+}
+
 function oauthOpenBrowserError(value: unknown): string | null {
   const raw = rawConfigRecord(value);
   if (!raw || !Object.hasOwn(raw, "oauthOpenBrowser")) return null;
@@ -2718,6 +2728,7 @@ export function validateConfigCandidate(value: unknown): { ok: true; config: Ocx
     ?? codexQuotaAutoRefreshError(value)
     ?? codexAccountPickerEnabledError(value)
     ?? emptyCompletionRetryError(value)
+    ?? dropCodexSafetyBufferingError(value)
     ?? oauthOpenBrowserError(value)
     ?? runtimeRoleError(value)
     ?? remoteGuiConfigError(value)
@@ -3684,6 +3695,7 @@ export function getDefaultConfig(): OcxConfig {
   return {
     port: 10100,
     emptyCompletionRetry: false,
+    dropCodexSafetyBuffering: false,
     managementUsageMaxReadBytes: 64 * 1024 * 1024,
     appOwnedMemoryBudgetMb: DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024),
     // Fresh/re-initialized configs are already written in the current three-tier
diff --git a/src/server/index.ts b/src/server/index.ts
index aedd6bf236..c6ce73b2f1 100644
--- a/src/server/index.ts
+++ b/src/server/index.ts
@@ -142,6 +142,7 @@ import {
 } from "./relay";
 export {
   consumeForInspection,
+  codexSafetyBufferingFilterOptions,
   relaySseWithFailedTail,
   relaySseWithHeartbeat,
   relayWithAbort,
diff --git a/src/server/relay-eager.ts b/src/server/relay-eager.ts
index 655997b813..a6e60d3d02 100644
--- a/src/server/relay-eager.ts
+++ b/src/server/relay-eager.ts
@@ -26,6 +26,7 @@

 import {
   adapterEofIncompleteFrame,
+  type CodexSafetyBufferingFilterOptions,
   createSseTerminalOutputBoundary,
   doneFrame,
   failedTailFrame,
@@ -83,6 +84,8 @@ export type EagerRelayOptions = {
   postCancelDrainBytes?: number;
   /** Injectable clock for tests. */
   now?: () => number;
+  /** Client output boundary filters (Codex safety-buffering hints). */
+  terminalBoundary?: CodexSafetyBufferingFilterOptions;
 };

 const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
@@ -111,7 +114,7 @@ export function relaySseEagerBounded(
   const terminalEncoder = new TextEncoder();
   const adapterEofFrame = adapterEofIncompleteFrame(terminalEncoder);
   const terminalSentinel = doneFrame(terminalEncoder);
-  const terminalBoundary = createSseTerminalOutputBoundary();
+  const terminalBoundary = createSseTerminalOutputBoundary(opts?.terminalBoundary);
   const activeRewrite: SseBlockRewrite | undefined = hooks.rewriteBlocks
     ?? (hooks.rewritePayload ? payloadRewriteAsBlockRewrite(hooks.rewritePayload) : undefined);
   const encodeFailedTail = (error: unknown): Uint8Array | null => {
diff --git a/src/server/relay.ts b/src/server/relay.ts
index 60b57ea025..d840b2e59c 100644
--- a/src/server/relay.ts
+++ b/src/server/relay.ts
@@ -162,7 +162,10 @@ export type SseTerminalOutputBoundary = {
  * terminal, and drops every later block/byte. A premature [DONE] is held until
  * a terminal arrives so clean EOF can synthesize one terminal and one sentinel.
  */
-export function createSseTerminalOutputBoundary(): SseTerminalOutputBoundary {
+export function createSseTerminalOutputBoundary(
+  options?: CodexSafetyBufferingFilterOptions,
+): SseTerminalOutputBoundary {
+  const dropSafetyBuffering = options?.dropCodexSafetyBuffering === true;
   const decoder = new TextDecoder();
   const encoder = new TextEncoder();
   const framer = new BoundedSseFrameBuffer(MAX_INSPECTION_SSE_FRAME_BYTES);
@@ -181,6 +184,10 @@ export function createSseTerminalOutputBoundary(): SseTerminalOutputBoundary {
       const payload = sseDataPayload(decoder.decode(frame.block));
       const isDone = payload === "[DONE]";
       const parsed = payload === null ? undefined : parseSsePayload(payload);
+      const safetyBuffering = dropSafetyBuffering && parsed !== undefined
+        ? codexSafetyBufferingBlockAction(parsed)
+        : "keep";
+      if (safetyBuffering === "drop") continue;
       const policyError = parsed !== undefined && isPolicyRewriteType(parsed)
         ? cyberPolicyTerminalError(parsed)
         : undefined;
@@ -189,7 +196,9 @@ export function createSseTerminalOutputBoundary(): SseTerminalOutputBoundary {
           decoder.decode(frame.block),
           policyFailurePayload(policyError, parsed),
         ))
-        : frame.block;
+        : safetyBuffering === "strip"
+          ? encoder.encode(stripCodexSafetyBufferingField(decoder.decode(frame.block), parsed))
+          : frame.block;
       if (isDone) {
         done = true;
         if (responsesTerminal) {
@@ -260,10 +269,11 @@ export function relaySseWithFailedTail(
   body: ReadableStream<Uint8Array>,
   upstream: AbortController,
   onClientGone?: (reason?: unknown) => void,
+  boundaryOptions?: CodexSafetyBufferingFilterOptions,
 ): ReadableStream<Uint8Array> {
   const reader = body.getReader();
   const encoder = new TextEncoder();
-  const terminalBoundary = createSseTerminalOutputBoundary();
+  const terminalBoundary = createSseTerminalOutputBoundary(boundaryOptions);
   let closed = false;
   const relayChunk = (
     controller: ReadableStreamDefaultController<Uint8Array>,
@@ -438,6 +448,29 @@ function isPolicyRewriteType(parsed: unknown): boolean {
   return type === "response.failed" || type === "response.incomplete" || type === "error";
 }

+/**
+ * Codex emits its safety-buffering hint in the SSE body as well as in headers:
+ * a `response.metadata` event whose `metadata.type` is `safety_buffering`, or a
+ * `safety_buffering` field on another event. The metadata event is dropped whole;
+ * the field is stripped so the carrying event is otherwise relayed unchanged.
+ */
+function codexSafetyBufferingBlockAction(parsed: unknown): "keep" | "drop" | "strip" {
+  const root = asJsonRecord(parsed);
+  if (!root) return "keep";
+  if (root.type === "response.metadata") {
+    const metadata = asJsonRecord(root.metadata);
+    if (metadata?.type === "safety_buffering") return "drop";
+  }
+  return Object.hasOwn(root, "safety_buffering") ? "strip" : "keep";
+}
+
+function stripCodexSafetyBufferingField(block: string, parsed: unknown): string {
+  const root = asJsonRecord(parsed);
+  if (!root) return block;
+  const { safety_buffering: _safetyBuffering, ...rest } = root;
+  return replaceSseDataPayload(block, JSON.stringify(rest));
+}
+
 function rewritePolicyTerminalBlock(block: string, payload: string): string {
   const newline = block.includes("\r\n") ? "\r\n" : "\n";
   const rewritten = replaceSseDataPayload(block, payload);
@@ -1422,7 +1455,31 @@ export function consumeForResponseLogMetadata(
  * body makes the caller (Codex) double-decode / truncate → "stream error" on every gpt passthrough.
  * Drop encoding + hop-by-hop headers; relay everything else (content-type, etc.) verbatim.
  */
-export function sanitizePassthroughHeaders(upstream: Headers): Headers {
+export const CODEX_SAFETY_BUFFERING_HEADERS = [
+  "x-codex-safety-buffering-enabled",
+  "x-codex-safety-buffering-faster-model",
+] as const;
+
+const CODEX_SAFETY_BUFFERING_HEADER_SET: ReadonlySet<string> = new Set(CODEX_SAFETY_BUFFERING_HEADERS);
+
+export interface CodexSafetyBufferingFilterOptions {
+  /**
+   * Drop Codex safety-buffering hints: the `x-codex-safety-buffering-*` response
+   * headers and the `safety_buffering` SSE metadata event / field. Absent and
+   * `false` relay everything unchanged.
+   */
+  dropCodexSafetyBuffering?: boolean;
+}
+
+/** Resolve the passthrough header policy from the loaded config (absent means "forward everything"). */
+export function codexSafetyBufferingFilterOptions(
+  config: { dropCodexSafetyBuffering?: boolean },
+): CodexSafetyBufferingFilterOptions {
+  return { dropCodexSafetyBuffering: config.dropCodexSafetyBuffering === true };
+}
+
+export function sanitizePassthroughHeaders(upstream: Headers, options?: CodexSafetyBufferingFilterOptions): Headers {
+  const dropSafetyBuffering = options?.dropCodexSafetyBuffering === true;
   const DROP = new Set([
     "content-encoding",
     "content-length",
@@ -1439,7 +1496,10 @@ export function sanitizePassthroughHeaders(upstream: Headers): Headers {
   ]);
   const out = new Headers();
   upstream.forEach((value, key) => {
-    if (!DROP.has(key.toLowerCase())) out.set(key, value);
+    const lower = key.toLowerCase();
+    if (DROP.has(lower)) return;
+    if (dropSafetyBuffering && CODEX_SAFETY_BUFFERING_HEADER_SET.has(lower)) return;
+    out.set(key, value);
   });
   return out;
 }
diff --git a/src/server/responses/core.ts b/src/server/responses/core.ts
index 9d0eea0d76..e199917968 100644
--- a/src/server/responses/core.ts
+++ b/src/server/responses/core.ts
@@ -304,6 +304,7 @@ import {
   markEagerRelaySseResponse,
   markNativePassthroughSseResponse,
   relaySseWithFailedTail,
+  codexSafetyBufferingFilterOptions,
   relayWithAbort,
   sanitizePassthroughHeaders,
 } from "../relay";
@@ -3850,6 +3851,9 @@ async function handleResponsesInner(
     let hostAdmissionLease = pendingHostAdmissionLease;
     pendingHostAdmissionLease = null;
     try {
+    const codexSafetyBufferingOptions = isCanonicalOpenAiForwardProvider(route.provider)
+      ? codexSafetyBufferingFilterOptions(config)
+      : undefined;
     const imageGenCallAliases = route.provider.authMode === "forward"
       ? new Map<string, { namespace: string; name: string }>()
       : imageGenToolCallAliases(toolBridgeMaps.toolNsMap, parsed._rawBody, translatorBudget);
@@ -4732,7 +4736,7 @@ async function handleResponsesInner(
     }
     break;
     }
-    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
+    const headers = sanitizePassthroughHeaders(upstreamResponse.headers, codexSafetyBufferingOptions);
     const resolvedModel = headers.get("openai-model")?.trim();
     if (resolvedModel && !logCtx.preserveResolvedModelFromRoute) logCtx.resolvedModel = resolvedModel;
     if (isUsageDebugEnabled()) {
@@ -4824,7 +4828,7 @@ async function handleResponsesInner(
       return new Response(upstreamResponse.body, {
         status: upstreamResponse.status,
         statusText: upstreamResponse.statusText,
-        headers: sanitizePassthroughHeaders(upstreamResponse.headers),
+        headers: sanitizePassthroughHeaders(upstreamResponse.headers, codexSafetyBufferingOptions),
       });
     }
     if (!upstreamResponse.ok) {
@@ -5027,6 +5031,7 @@ async function handleResponsesInner(
           onDone: () => unregisterTurn(turnAc),
         }, {
           clientGoneSignal: options.abortSignal,
+          terminalBoundary: codexSafetyBufferingOptions,
           ...(inlineEagerRewrite ? { rewriteBudget: translatorBudget } : {}),
         });
         // When selected, this relay closes response.completed even if upstream
@@ -5110,7 +5115,8 @@ async function handleResponsesInner(
       const rewrittenBody = clientBlockRewrite !== undefined
         ? relaySseWithBlockRewrite(nativeBody, clientBlockRewrite, translatorBudget)
         : nativeBody;
-      const clientBody = relaySseWithFailedTail(rewrittenBody, upstream, reason => clientGone.abort(reason));
+      const clientBody = relaySseWithFailedTail(rewrittenBody, upstream, reason => clientGone.abort(reason),
+        codexSafetyBufferingOptions);
       return markNativePassthroughSseResponse(new Response(clientBody, {
         status: upstreamResponse.status,
         headers,
@@ -5238,7 +5244,7 @@ async function handleResponsesInner(
             }
             throw error;
           }
-          const sseHeaders = sanitizePassthroughHeaders(headers);
+          const sseHeaders = sanitizePassthroughHeaders(headers, codexSafetyBufferingOptions);
           sseHeaders.set("content-type", "text/event-stream");
           sseHeaders.set("cache-control", "no-store");
           return new Response(stream, {
diff --git a/src/types/config.ts b/src/types/config.ts
index 8cf1246979..4d2c63fdf1 100644
--- a/src/types/config.ts
+++ b/src/types/config.ts
@@ -335,6 +335,16 @@ export interface OcxConfig {
   client?: OcxClientConnectionConfig;
   /** Opt in to one identical-turn retry when a Responses completion has no text or tool call. */
   emptyCompletionRetry?: boolean;
+  /**
+   * Drop the Codex safety-buffering hints from a Codex Responses passthrough: the
+   * `x-codex-safety-buffering-*` response headers, `response.metadata` SSE events of
+   * type `safety_buffering`, and the `safety_buffering` field on other SSE events.
+   * The Codex TUI turns those hints into a "retry with a faster model" prompt whose
+   * default action switches the session to a weaker model, so an unattended session
+   * can lose its model to a stray keystroke. Absent and `false` relay everything
+   * unchanged.
+   */
+  dropCodexSafetyBuffering?: boolean;
   /**
    * Whether a login may open a browser on the machine running the proxy.
    *

```

## Hint P revalidation

Previous D: presentation source complete; final hosted CI remains in delivery. This branch starts from the common docs checkpoint bd34120180 and baseline product 69e3dcda. Original #3652 does not apply cleanly because relay upstreamError handling changed. Carry nonconflicting hunks and manually adapt relay/core/config hunks, preserving cancellation and error capture. Independent H1-H3 plan reflection ALIGNED remains applicable.
