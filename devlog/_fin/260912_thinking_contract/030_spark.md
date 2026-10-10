# Spark Lite metadata follows body shape

Class C3 bounded compatibility. Independent of presentation/hint; depends on roadmap. MODIFY src/adapters/openai-responses.ts only inside canonical OpenAI forwarding and final wire model gpt-5.3-codex-spark. Add bodyCarriesLiteToolShape next to existing tool-shape helpers: Array.isArray(body.input) && body.input.some(item => isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools) && item.tools.length > 0). After final Spark body construction, delete all case variants of CODEX_RESPONSES_LITE_HEADER then set it to liteShaped ? "true" : "false". Existing prepareCodexWsRequest projects it onto native frame metadata.

Before: Spark deletes the header, allowing stale native metadata to survive. After: tool-less/top-level-tool Spark frames advertise false; nonempty Lite catalog frames advertise true despite conflicting inherited header. No retirement, no changes to model availability, no user service changes.

MODIFY tests/codex-integration/codex-metadata-integrity.test.ts: alias resolved final model, inherited true/false/mixed-case/absent header, Lite tool body true, empty Lite group false, malformed metadata keeps HTTP fallback/body, noncanonical remains unchanged. MODIFY tests/responses/ws-upstream-reuse.test.ts: legacy true socket retires when adapter produces false, replacement same identity reused, raw request immutable. MODIFY all eight existing architecture locale pages and structure/transports/responses.md, referencing body-shape rule from shared area owners. Adopt latest #4130 source diff, preserving author; do not import historical earlier heads.

Verification: source diff review and final-branch hosted ci.yml lane=all. Tests NOT RUN locally. Success proves framing and connection identity, not a live backend EOF fix or all tool-bearing EOF cases. Remaining acceptance: broader tool-format conversion stays out of scope.

## Pinned source hunks (apply with corrections above)

```diff
diff --git a/src/adapters/openai-responses.ts b/src/adapters/openai-responses.ts
index c4aa523ee6..8fbe43816d 100644
--- a/src/adapters/openai-responses.ts
+++ b/src/adapters/openai-responses.ts
@@ -864,6 +864,21 @@ function promoteClientLoadedTools(body: unknown): unknown {
 }

 const MAX_RESPONSES_CALL_ID_LENGTH = 64;
+
+/**
+ * Whether the outgoing body still delivers tools through the responses-lite shape.
+ *
+ * Lite carries the client catalog as an `additional_tools` input item; the non-Lite wire shape
+ * expects top-level `tools`. Anything that flips the Lite advertisement has to agree with the
+ * shape actually being sent, or the destination silently loses the tool surface.
+ */
+function bodyCarriesLiteToolShape(body: Record<string, unknown>): boolean {
+  if (!Array.isArray(body.input)) return false;
+  return body.input.some(item =>
+    isPlainObject(item) && item.type === "additional_tools"
+    && Array.isArray(item.tools) && item.tools.length > 0
+  );
+}
 const REPAIRED_CALL_ID_PREFIX = "call_ocx_";
 const REPAIRED_CALL_ID_DIGEST_LENGTH = MAX_RESPONSES_CALL_ID_LENGTH - REPAIRED_CALL_ID_PREFIX.length;

@@ -2515,12 +2530,22 @@ export function createResponsesPassthroughAdapter(provider: OcxProviderConfig):
         parsed.modelId,
       );
       if (isCanonicalOpenAiForwardProvider(provider)) {
-        // Spark closes Responses Lite streams before a terminal completion. Select compatibility
-        // from the final wire model so aliases cannot leave the caller or a static header enabled.
+        // Select Spark's Lite compatibility from the final wire model, including aliases, and
+        // let the BODY decide it. The header also overrides native WS metadata downstream, so a
+        // forwarded or statically configured value must never contradict the shape being sent.
+        //
+        // The synchronized catalog keeps `use_responses_lite: true` for Spark precisely because
+        // it selects tool delivery (`input[].additional_tools` instead of top-level `tools`), and
+        // stripSparkCompatibility filters that group in place rather than promoting it. So a
+        // Lite-shaped body is pinned back ON — otherwise an inherited `false` advertises non-Lite
+        // while the tools exist only in the Lite shape, and Spark loses the tool surface. Only a
+        // body with no Lite tool group is downgraded, which is what the stream fix needs.
         if (isPlainObject(finalBody) && finalBody.model === "gpt-5.3-codex-spark") {
+          const liteShaped = bodyCarriesLiteToolShape(finalBody);
           for (const name of Object.keys(headers)) {
             if (name.toLowerCase() === CODEX_RESPONSES_LITE_HEADER) delete headers[name];
           }
+          headers[CODEX_RESPONSES_LITE_HEADER] = liteShaped ? "true" : "false";
         }
         const routingHeaders = new Headers(headers);
         applyCodexRoutingHint(routingHeaders, finalBody);

```

## Spark P revalidation

Prior D: hint source/security review PASS, final hosted tests pending. This independent branch starts from bd34120180. Latest #4130 hunks still apply cleanly. CCA summary and hint branches do not modify this adapter. Body-dependent Lite true/false, canonical final wire model and no retirement remain the acceptance contract.

## Spark design reflection amendments

S1 accepted: apply the existing modelSuffixBracketStrip normalization to finalBody before deciding Lite, using the same immutable object serialized later. A canonical gpt-5.3-codex-spark[1m] request that strips to Spark gets the policy; a final non-Spark model does not. S2 accepted: all eight architecture paragraphs say nonempty additional_tools tools array, not merely group presence; source PR outstanding documentation finding is addressed. S3 accepted: tests cover catalog filtered empty, surviving functions group, only top-level tools, both alias directions and preserved noncanonical configured Lite. Check both actual serialized body and WS header metadata; shape detection is not tool-support validation.
