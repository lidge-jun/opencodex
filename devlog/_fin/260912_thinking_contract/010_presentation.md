# Presentation contract

Class C4 public protocol contract. Depends on roadmap lock. MODIFY src/bridge.ts: closeCurrentRawReasoning and reasoning_raw_delta emit response.reasoning_text.delta/done with content_index:0; final items use summary:[] and content:[{type:reasoning_text,text}]. buildResponseJSONWithBudget mirrors this. Keep hidden txt-only replay envelopes intact. DELETE src/server/responses-reasoning-summary-rewrite.ts and its obsolete unit test; MODIFY core.ts to remove imports and SSE/JSON content-to-summary rewrites. MODIFY both layout manifests to remove that test. Adopt the exact #4301 hunks below except reporter video and historical verification record.

MODIFY provider.ts, registry.ts, derive.ts, router.ts and auth-cors.ts to carry showThinkingSummary boolean (preserve explicit false). Seed only google-antigravity true. Creation: provider config/registry; serialization: providerConfigSeed and deriveKeyLoginMap; deserialization: config provider passthrough and management field policy; consumers: routedProviderConfig, final-route normalization, Google request builder. No new enum.

MODIFY core.ts final-route normalization: apply provider default only when original reasoning.summary is omitted, never explicit none; recompute on each final route so fallback cannot inherit another provider default. Provider opt-in authorizes summary display, not raw-to-summary conversion.

MODIFY google.ts shared part classifier to use existing thinking_delta only for Gemini thought summaries under verified Gemini model provenance; CCA Claude/gpt-oss thought text remains reasoning_raw_delta. Persist request-local Gemini identity using existing adapter state, used by both stream and buffered classifier calls. includeThoughts stays provider-opted, Gemini-only, non-image and explicit-hide aware. MODIFY google-wire-compiler.ts to retain only boolean true includeThoughts, independently of thinkingLevel. Do not claim raw text is an actual summary.

MODIFY the #4287 end-to-end fixture: raw DeepSeek content remains content with empty summary even under provider opt-in; actual CCA Gemini thought parts use summary; omitted vs none vs auto, explicit provider false, saved-row enrichment, fallback reset, streaming/buffered paths. Extend existing Google tests and bridge raw tests; both layout manifests register responses-show-thinking-summary.test.ts. Update English providers docs and structure owners, keeping locale statements consistent. Source tests are authored but run only by hosted CI.

Acceptance: raw event fixture => content delta and no summary delta; actual Gemini summary fixture => summary only when requested/provider-opted; explicit none => no synthesized summary and no includeThoughts request; false/unknown provider => no opt-in; fallback to unopted route => hidden behavior reset; replay envelope decodes same raw text and tool continuation remains valid; native Responses mixed content/summary remains byte-semantically native. No model prose synthesizer is introduced.

## Source patch blueprint

```diff
diff --git a/src/bridge.ts b/src/bridge.ts
index 20e7c3fe09..bc90f35b94 100644
--- a/src/bridge.ts
+++ b/src/bridge.ts
@@ -663,16 +663,13 @@ export function bridgeToResponsesSSE(
       const closeCurrentRawReasoning = () => {
         if (!currentRawReasoning) return;
         rawReasoningForNextToolCall = currentRawReasoning.text;
-        emit("response.reasoning_summary_text.done", {
-          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, summary_index: 0, text: currentRawReasoning.text,
-        });
-        emit("response.reasoning_summary_part.done", {
-          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, summary_index: 0,
-          part: { type: "summary_text", text: currentRawReasoning.text },
+        emit("response.reasoning_text.done", {
+          item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex, content_index: 0, text: currentRawReasoning.text,
         });
         const item = {
           type: "reasoning", id: currentRawReasoning.itemId,
-          summary: [{ type: "summary_text", text: currentRawReasoning.text }],
+          summary: [] as never[],
+          content: [{ type: "reasoning_text", text: currentRawReasoning.text }],
         };
         emit("response.output_item.done", { output_index: currentRawReasoning.outputIndex, item });
         retainFinishedItem(item as OutputItem, currentRawReasoning.textBytes, "reasoning");
@@ -1111,10 +1108,6 @@ export function bridgeToResponsesSSE(
                 const itemId = `rs_${uuid()}`;
                 const item = { type: "reasoning", id: itemId, summary: [] as { type: string; text: string }[] };
                 emit("response.output_item.added", { output_index: outputIndex, item });
-                emit("response.reasoning_summary_part.added", {
-                  item_id: itemId, output_index: outputIndex, summary_index: 0,
-                  part: { type: "summary_text", text: "" },
-                });
                 currentRawReasoning = { itemId, outputIndex, text: "", textBytes: 0 };
               }
               ({ value: currentRawReasoning.text, bytes: currentRawReasoning.textBytes } = appendString(
@@ -1123,9 +1116,13 @@ export function bridgeToResponsesSSE(
                 event.text,
                 "reasoning",
               ));
-              emit("response.reasoning_summary_text.delta", {
+              // Raw reasoning (openai-chat reasoning_content, kiro tags) rides the CONTENT
+              // channel, matching native gpt-oss passthrough: Codex applies its own display
+              // policy, so the desktop band shows the "Thinking…" placeholder instead of the
+              // raw CoT (the #45 summary-channel display intent is intentionally reverted).
+              emit("response.reasoning_text.delta", {
                 item_id: currentRawReasoning.itemId, output_index: currentRawReasoning.outputIndex,
-                summary_index: 0, delta: event.text,
+                content_index: 0, delta: event.text,
               });
               break;
             }
@@ -1780,7 +1777,8 @@ function buildResponseJSONWithBudget(
     }
     pushOutput({
       type: "reasoning", id: `rs_${uuid()}`,
-      summary: [{ type: "summary_text", text: currentRawReasoning }],
+      summary: [],
+      content: [{ type: "reasoning_text", text: currentRawReasoning }],
     }, currentRawReasoningBytes, "reasoning");
     currentRawReasoning = "";
     currentRawReasoningBytes = 0;

```

## Pinned source hunks (apply with corrections above)

```diff
diff --git a/src/adapters/google-wire-compiler.ts b/src/adapters/google-wire-compiler.ts
index 88c482ba7d..aa835e50b4 100644
--- a/src/adapters/google-wire-compiler.ts
+++ b/src/adapters/google-wire-compiler.ts
@@ -130,12 +130,20 @@ function compileGenerationConfig(value: unknown): JsonObject | undefined {
     ))].slice(0, 5);
     if (stopSequences.length > 0) out.stopSequences = stopSequences;
   }
-  if (isObject(value.thinkingConfig) && typeof value.thinkingConfig.thinkingLevel === "string") {
-    const raw = value.thinkingConfig.thinkingLevel.toLowerCase();
-    const thinkingLevel = GOOGLE_THINKING_LEVELS.has(raw)
-      ? raw
-      : (["xhigh", "max", "ultra"].includes(raw) ? "high" : undefined);
-    if (thinkingLevel) out.thinkingConfig = { thinkingLevel };
+  if (isObject(value.thinkingConfig)) {
+    const thinking: JsonObject = {};
+    if (typeof value.thinkingConfig.thinkingLevel === "string") {
+      const raw = value.thinkingConfig.thinkingLevel.toLowerCase();
+      const thinkingLevel = GOOGLE_THINKING_LEVELS.has(raw)
+        ? raw
+        : (["xhigh", "max", "ultra"].includes(raw) ? "high" : undefined);
+      if (thinkingLevel) thinking.thinkingLevel = thinkingLevel;
+    }
+    // The one key that makes Google return `thought: true` text. Cloud Code Assist serves
+    // thinking either way (thoughtsTokenCount stays non-zero) but withholds the text unless the
+    // request opts in, so dropping it here silently reinstates the missing-thinking behavior.
+    if (value.thinkingConfig.includeThoughts === true) thinking.includeThoughts = true;
+    if (Object.keys(thinking).length > 0) out.thinkingConfig = thinking;
   }
   if (Array.isArray(value.responseModalities)) {
     const valid = value.responseModalities.filter((m): m is string => typeof m === "string" && ["TEXT", "IMAGE", "AUDIO"].includes(m));
diff --git a/src/adapters/google.ts b/src/adapters/google.ts
index 7fcc88ba59..5a6675f6e4 100644
--- a/src/adapters/google.ts
+++ b/src/adapters/google.ts
@@ -866,11 +866,27 @@ export function createGoogleAdapter(provider: OcxProviderConfig): ProviderAdapte
         );
         antigravityModel = wireModelId;
         antigravitySession = sessionId;
+        // Gemini returns no chain-of-thought TEXT unless the request opts in. Probed against CCA
+        // 2026-09-12: `gemini-3.8-flash-high` answered with thoughtsTokenCount=321 and zero
+        // `thought` parts, then 358-652 chars of genuine reasoning once includeThoughts was set.
+        // Scoped to Gemini wire ids — Claude-on-CCA accepts the flag but never returns thought
+        // parts, and gpt-oss rejects it outright (400 INVALID_ARGUMENT, which would break every
+        // gpt-oss turn). Gated on the provider's visible-thinking opt-in so a user who wants
+        // thinking hidden does not pay conversation-history tokens for text nobody renders;
+        // `hideThinkingSummary !== true` is the same per-request gate the response path uses, so
+        // a client that explicitly asked for hidden thinking is not billed for the text either.
+        const includeThoughts = provider.showThinkingSummary === true
+          && parsed.options.hideThinkingSummary !== true
+          && /^gemini-/.test(wireModelId)
+          && !isImageCapableModel(parsed.modelId);
         // Effort → thinkingConfig for CCA (CLIProxyAPI proven: request.generationConfig.thinkingConfig).
         // Suffix/compat IDs return thinkingLevel=undefined — the suffix IS the effort, no contradiction.
-        if (thinkingLevel) {
+        if (thinkingLevel || includeThoughts) {
           const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
-          gc.thinkingConfig = { thinkingLevel };
+          gc.thinkingConfig = {
+            ...(thinkingLevel ? { thinkingLevel } : {}),
+            ...(includeThoughts ? { includeThoughts: true } : {}),
+          };
           body.generationConfig = gc;
         }
         // Reasoning continuity: Gemini models re-inject cached thoughtSignatures; Claude-on-Antigravity
diff --git a/src/providers/derive.ts b/src/providers/derive.ts
index 67e6c0522e..7edf28787b 100644
--- a/src/providers/derive.ts
+++ b/src/providers/derive.ts
@@ -43,6 +43,7 @@ export interface DerivedKeyLoginProvider {
   autoToolChoiceOnlyModels?: string[];
   preserveReasoningContentModels?: string[];
   requiresReasoningPlaceholderModels?: string[];
+  showThinkingSummary?: boolean;
   reasoningSplitModels?: string[];
   reasoningDetailsModels?: string[];
   thinkingToggleModels?: string[];
@@ -267,6 +268,7 @@ export function providerConfigSeed(entry: ProviderRegistryEntry): OcxProviderCon
     ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
     ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
     ...(entry.requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels: [...entry.requiresReasoningPlaceholderModels] } : {}),
+    ...(entry.showThinkingSummary !== undefined ? { showThinkingSummary: entry.showThinkingSummary } : {}),
     ...(entry.reasoningSplitModels ? { reasoningSplitModels: [...entry.reasoningSplitModels] } : {}),
     ...(entry.reasoningDetailsModels ? { reasoningDetailsModels: [...entry.reasoningDetailsModels] } : {}),
     ...(entry.thinkingToggleModels ? { thinkingToggleModels: [...entry.thinkingToggleModels] } : {}),
@@ -315,6 +317,7 @@ export function deriveKeyLoginMap(): Record<string, DerivedKeyLoginProvider> {
       ...(entry.autoToolChoiceOnlyModels ? { autoToolChoiceOnlyModels: [...entry.autoToolChoiceOnlyModels] } : {}),
       ...(entry.preserveReasoningContentModels ? { preserveReasoningContentModels: [...entry.preserveReasoningContentModels] } : {}),
       ...(entry.requiresReasoningPlaceholderModels ? { requiresReasoningPlaceholderModels: [...entry.requiresReasoningPlaceholderModels] } : {}),
+      ...(entry.showThinkingSummary !== undefined ? { showThinkingSummary: entry.showThinkingSummary } : {}),
       ...(entry.reasoningSplitModels ? { reasoningSplitModels: [...entry.reasoningSplitModels] } : {}),
       ...(entry.reasoningDetailsModels ? { reasoningDetailsModels: [...entry.reasoningDetailsModels] } : {}),
       ...(entry.thinkingToggleModels ? { thinkingToggleModels: [...entry.thinkingToggleModels] } : {}),
@@ -567,6 +570,7 @@ export function enrichProviderFromRegistry(name: string, prov: OcxProviderConfig
   if (!prov.thinkingToggleModels && seed.thinkingToggleModels) prov.thinkingToggleModels = [...seed.thinkingToggleModels];
   if (!prov.thinkingBudgetModels && seed.thinkingBudgetModels) prov.thinkingBudgetModels = [...seed.thinkingBudgetModels];
   if (prov.escapeBuiltinToolNames === undefined && seed.escapeBuiltinToolNames !== undefined) prov.escapeBuiltinToolNames = seed.escapeBuiltinToolNames;
+  if (prov.showThinkingSummary === undefined && seed.showThinkingSummary !== undefined) prov.showThinkingSummary = seed.showThinkingSummary;
   if (prov.keyOptional === undefined && seed.keyOptional !== undefined) prov.keyOptional = seed.keyOptional;
   if (prov.freeTier === undefined && seed.freeTier !== undefined) prov.freeTier = seed.freeTier;
   if (prov.modelSuffixBracketStrip === undefined && seed.modelSuffixBracketStrip !== undefined) prov.modelSuffixBracketStrip = seed.modelSuffixBracketStrip;
diff --git a/src/providers/registry.ts b/src/providers/registry.ts
index f72bb7650b..e483e9db23 100644
--- a/src/providers/registry.ts
+++ b/src/providers/registry.ts
@@ -343,6 +343,10 @@ export interface ProviderRegistryEntry {
   autoToolChoiceOnlyModels?: string[];
   preserveReasoningContentModels?: string[];
   requiresReasoningPlaceholderModels?: string[];
+  /**
+   * Opt this provider into visible thinking summaries (see OcxProviderConfig.showThinkingSummary).
+   */
+  showThinkingSummary?: boolean;
   reasoningSplitModels?: string[];
   reasoningDetailsModels?: string[];
   thinkingToggleModels?: string[];
@@ -367,7 +371,7 @@ export type ProviderConfigSeed = Pick<
   | "modelMaxInputTokens" | "defaultMaxOutputTokens" | "modelMaxOutputTokens"
   | "reasoningEfforts" | "modelReasoningEfforts" | "modelDefaultReasoningEfforts" | "reasoningEffortMap" | "modelReasoningEffortMap" | "reasoningWireFormat"
   | "noVisionModels" | "noReasoningModels" | "noTemperatureModels" | "noTopPModels" | "noPenaltyModels"
-  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "requiresReasoningPlaceholderModels" | "reasoningSplitModels" | "reasoningDetailsModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "escapeBuiltinToolNames" | "openaiChatEofTolerance"
+  | "autoToolChoiceOnlyModels" | "preserveReasoningContentModels" | "requiresReasoningPlaceholderModels" | "reasoningSplitModels" | "reasoningDetailsModels" | "thinkingToggleModels" | "thinkingBudgetModels" | "escapeBuiltinToolNames" | "openaiChatEofTolerance" | "showThinkingSummary"
   | "googleMode" | "project" | "location" | "headers"
 >;

@@ -2045,7 +2049,7 @@ export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
   // path must stay RELATIVE: this row sets `allowBaseUrlOverride`, and an absolute `url` would
   // retarget a user's custom base back to Google. A leading `./` is required because a bare
   // `v1internal:` reads as a URL scheme and `providerModelDiscoverySpecError` rejects it.
-  { id: "google-antigravity", alias: "agy", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", allowBaseUrlOverride: true, dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, liveModels: true, defaultModel: "gemini-3.8-flash", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, modelInputModalities: ANTIGRAVITY_MODEL_INPUT_MODALITIES, modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS, googleMode: "cloud-code-assist", jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"], modelDiscovery: { path: "./v1internal:fetchAvailableModels" } },
+  { id: "google-antigravity", alias: "agy", label: "Google Antigravity", adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authKind: "oauth", allowBaseUrlOverride: true, dashboardUrl: "https://antigravity.google", models: ANTIGRAVITY_MODELS, liveModels: true, defaultModel: "gemini-3.8-flash", modelContextWindows: ANTIGRAVITY_MODEL_CONTEXT_WINDOWS, modelInputModalities: ANTIGRAVITY_MODEL_INPUT_MODALITIES, modelReasoningEfforts: ANTIGRAVITY_MODEL_EFFORTS, googleMode: "cloud-code-assist", showThinkingSummary: true, jawcodeBundle: "google", extraMetadataAliases: ["antigravity", "gemini-antigravity"], modelDiscovery: { path: "./v1internal:fetchAvailableModels" } },
   { id: "azure-openai", label: "Azure OpenAI", adapter: "azure-openai", baseUrl: "https://{resource}.openai.azure.com/openai", authKind: "key", featured: true, dashboardUrl: "https://portal.azure.com" },
   { id: "ollama", label: "Ollama (local)", adapter: "openai-chat", baseUrl: "http://localhost:11434/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
   { id: "vllm", label: "vLLM (local)", adapter: "openai-chat", baseUrl: "http://localhost:8000/v1", authKind: "local", allowPrivateNetworkByDefault: true, allowBaseUrlOverride: true, featured: true, note: "Local — key usually blank" },
diff --git a/src/router.ts b/src/router.ts
index 55a0326fce..bf2b9b4b98 100644
--- a/src/router.ts
+++ b/src/router.ts
@@ -410,6 +410,13 @@ export function routedProviderConfig(providerName: string, provider: OcxProvider
     ...(provider.preserveResponsesReasoningContent === undefined && registryEntry.preserveResponsesReasoningContent !== undefined
       ? { preserveResponsesReasoningContent: registryEntry.preserveResponsesReasoningContent }
       : {}),
+    // The request path resolves through routedProviderConfig() and never calls
+    // enrichProviderFromRegistry(), so a saved provider row written before the
+    // registry learned this flag must be backfilled here or route.provider never
+    // carries it and the showThinkingSummary opt-in stays dead.
+    ...(provider.showThinkingSummary === undefined && registryEntry.showThinkingSummary !== undefined
+      ? { showThinkingSummary: registryEntry.showThinkingSummary }
+      : {}),
     // Registry-only client-facing repair policy (#938): fill only when the
     // saved provider has no explicit policy; clone so runtime never aliases
     // the registry constant.
diff --git a/src/server/auth-cors.ts b/src/server/auth-cors.ts
index 3a93246cd0..93377b5573 100644
--- a/src/server/auth-cors.ts
+++ b/src/server/auth-cors.ts
@@ -885,6 +885,7 @@ const PROVIDER_CONFIG_FIELD_POLICY = {
   autoToolChoiceOnlyModels: "editor",
   preserveReasoningContentModels: "editor",
   requiresReasoningPlaceholderModels: "editor",
+  showThinkingSummary: "editor",
   retryOn429: "editor",
   transientRetryOn5xx: "editor",
   reasoningSplitModels: "editor",
diff --git a/src/server/responses/core.ts b/src/server/responses/core.ts
index cccd942026..852cd9f8b0 100644
--- a/src/server/responses/core.ts
+++ b/src/server/responses/core.ts
@@ -2467,6 +2467,20 @@ async function resolveSubagentFallbackModelEligibility(args: {
   };
 }

+/**
+ * Whether the client explicitly asked for hidden thinking (`reasoning.summary: "none"`).
+ *
+ * Pinned: parseRequest collapses "omitted" and "none" into one hideThinkingSummary
+ * flag, so the raw request body is the ONLY place that still distinguishes them.
+ * Provider opt-ins like showThinkingSummary must consult this — never the flag
+ * alone — or a future caller that copies only the flag would silently unlock an
+ * explicit opt-out.
+ */
+function clientExplicitlyHidThinking(parsed: OcxParsedRequest): boolean {
+  const rawReasoning = (parsed._rawBody as { reasoning?: { summary?: unknown } } | undefined)?.reasoning;
+  return typeof rawReasoning === "object" && rawReasoning !== null
+    && (rawReasoning as { summary?: unknown }).summary === "none";
+}
 /**
  * Apply every route-dependent request mutation against the final selected route.
  * Must run only after subagent fallback has settled the model/provider.
@@ -2508,6 +2522,15 @@ async function applyFinalRouteRequestNormalization(args: {
   // this request will actually use (#404).
   route.provider = resolveOpenCodeGoTransport(route.provider, getOrAllocateRequestSessionLane(req));
   route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire);
+  // Provider-opted visible thinking (e.g. google-antigravity): parseRequest hides thinking
+  // whenever the client omits reasoning.summary, which is the Codex default. A provider that
+  // serves genuine user-facing reasoning opts back into the summary channel here, so thought
+  // parts (Gemini thought, content-channel reasoning_text) reach the client instead of only
+  // the hidden replay envelopes. An explicit client reasoning.summary "none" still wins.
+  if (route.provider.showThinkingSummary === true && parsed.options.hideThinkingSummary === true
+    && !clientExplicitlyHidThinking(parsed)) {
+    parsed.options.hideThinkingSummary = false;
+  }
   if (preserveAnthropicResponseModel) parsed._responseModelId = responseModelId;
   logCtx.model = route.modelId;
   logCtx.provider = route.providerName;
diff --git a/src/types/provider.ts b/src/types/provider.ts
index e65130a4fa..b6374a991a 100644
--- a/src/types/provider.ts
+++ b/src/types/provider.ts
@@ -746,6 +746,15 @@ export interface OcxProviderConfig {
    * out explicitly (e.g. MiniMax, where low effort disables thinking).
    */
   requiresReasoningPlaceholderModels?: string[];
+  /**
+   * Opt-in: surface upstream thinking as visible reasoning summaries even when the
+   * client did not send `reasoning.summary`. parseRequest hides thinking by default
+   * (Codex omits the field), which strands genuine reasoning — e.g. Gemini `thought`
+   * parts on the google-antigravity (Cloud Code Assist) wire — in hidden replay
+   * envelopes. An explicit client `reasoning.summary: "none"` still wins. Set `false`
+   * to opt a seeded preset back out.
+   */
+  showThinkingSummary?: boolean;
   /**
    * Opt-in same-target 429 retry policy. Codex itself never retries 429 (it retries 5xx only,
    * openai/codex#30471), and single-key pools have no failover, so the proxy waits and replays

```

## Reflection corrections accepted

Explicit wire reasoning.summary:"none" wins. A client that serializes configured none as omission cannot be distinguished from unspecified preference. No client config rewrite or global catalog summary default changes. Summary classification is limited to built CCA Gemini requests; unknown/uninitialized, direct Google/Vertex and CCA Claude/gpt-oss remain raw. Streaming and buffered summary-to-tool continuations assert exact Google signature on correct call; never emit Google signatures as Anthropic thinking_signature. Hidden unsigned summaries may disappear but required tool replay state survives. Exercise final assistant text and terminal order, fallback in both directions, and remove replay-comparison rewrite alongside SSE/JSON rewrite. Desktop appearance remains client-controlled; source patch comments claiming an unconditional placeholder are replaced during adoption.

## Presentation P revalidation

Prior D: roadmap locked; next presentation implementation. Both source patches apply to baseline; combined application requires keeping the newer no-rewrite expectation. Shared classifier signatures remain current. Implement CCA-only provider default by recomputing parsed.options.hideThinkingSummary from raw summary each final route for inboundWire responses; other inbound types preserve their existing flag. Missing raw request leaves original hide flag authoritative. CCA Gemini classification records boolean in existing per-request adapter closure on each build; default false.

C review corrections: fixture summary emission now depends on includeThoughts; provider false + client auto does not request upstream summaries. Signature regression exercises actual SSE and JSON serializers, visible/hidden modes, a tool-ending first turn, exact signature and real matching functionResponse. Final-answer behavior is covered separately by bridge and combo tests.
