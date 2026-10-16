# Encode large native HTTP uploads at the physical send

Depends on the docs-only roadmap audit and coordinator ROADMAP LOCKED. This document proposes changes; none have been applied.

Carry source PR #6508 commit `dd4fc9a8f732699d88f46058c3298073d9aa2317` by Maxy Milan Sorée, preserving the original commit with `git cherry-pick -x` after rebasing this task branch onto current dev. Add `Co-authored-by: Maxy Milan Sorée <maxy@mxymedia.nl>` to the eventual PR description. Do not alter or close the source PR.

The transport code currently forwards a serialized string unchanged at `src/server/responses/fetch-helpers.ts:195`. The carry encodes only native Responses and compact strings at least 1 MiB in UTF-8, after final URL reconstruction and plugin rewrite. It leaves WebSocket selection, non-native destinations, headers, abort signal and replay policy unchanged. The extra allocation is bounded by existing request admission, not a new retained context store. Keep the existing transport leaf; no new module or dependency is justified for this small boundary change.

## Exact source carry

All five paths below are MODIFY. Apply the source delta, then revalidate against the branch's current source. No deletion or credential-owner change is planned.

```diff
diff --git a/docs-site/src/content/docs/reference/configuration/server.md b/docs-site/src/content/docs/reference/configuration/server.md
index 5a434cfa4c..25198749be 100644
--- a/docs-site/src/content/docs/reference/configuration/server.md
+++ b/docs-site/src/content/docs/reference/configuration/server.md
@@ -79,6 +79,11 @@ refusal as rate-limit or quota evidence against the credential it was holding. T
 requests such as vision and web search are replayed normally, because repeating them cannot
 duplicate a turn.

+Large native ChatGPT Responses and compact HTTP requests use UTF-8 byte-buffer uploads to avoid
+Bun resetting a large string upload before response headers arrive. This preserves the request
+contents and does not enable automatic retries. A genuine connection reset still follows the
+replay-refusal policy above.
+
 A native Responses provider can opt into replacing that send with
 [`retryOnReset`](/reference/configuration/providers/#provider-entries-ocxproviderconfig). The same grant covers the
 case where the connection survives the header and the SSE body then dies carrying only control
diff --git a/src/server/responses/fetch-helpers.ts b/src/server/responses/fetch-helpers.ts
index 524a026cf6..610b7c2cac 100644
--- a/src/server/responses/fetch-helpers.ts
+++ b/src/server/responses/fetch-helpers.ts
@@ -192,8 +192,17 @@ export function sendWithConnectionPolicy(
   const egressInit = redirectedToLoopback
     ? { proxy: false as const }
     : decide ? providerEgressSendInit(egress, physicalFetch, input) : {};
+  // Bun can reset large native Codex string uploads before receiving headers while
+  // the identical UTF-8 buffer succeeds. Convert only at the final HTTP send so
+  // WebSocket selection still sees the serialized string and no retry is added.
+  const target = input instanceof Request ? input.url : String(input);
+  const body = init?.body;
+  const largeCodexBody = typeof body === "string"
+    && /^https:\/\/chatgpt\.com\/backend-api\/codex\/responses(?:\/compact)?$/.test(target)
+    && Buffer.byteLength(body, "utf8") >= 1024 * 1024;
   return physicalFetch(input, {
     ...init,
+    ...(largeCodexBody ? { body: Buffer.from(body, "utf8") } : {}),
     headers,
     redirect: "manual",
     ...(fresh ? { keepalive: false } : {}),
diff --git a/structure/transports/byte-accounting.md b/structure/transports/byte-accounting.md
index 2e1c59f23b..9714dc7fef 100644
--- a/structure/transports/byte-accounting.md
+++ b/structure/transports/byte-accounting.md
@@ -27,6 +27,11 @@ hard byte cap. Per-body limits, parsing, compression, and reader error envelopes
 `tests/usage/request-decompress.test.ts` covers exact accounting across codecs and Unicode/numeric
 normalization, UTF-8 counting without encoded copies, and release after malformed or optional empty input.

+The final native ChatGPT Responses HTTP send in `src/server/responses/fetch-helpers.ts` encodes JSON
+strings of at least 1 MiB as a UTF-8 buffer for Bun upload compatibility. This is a transport copy,
+not a counting allocation or retained continuation. Existing body admission limits still apply;
+the serialization observation keeps its existing lifetime, and nested dispatch reuses the buffer.
+
 ## Raised HTTP body admission

 `src/server/inbound-body-admission.ts` reserves the full resolved `maxInboundBodyBytes` allowance
diff --git a/structure/transports/responses.md b/structure/transports/responses.md
index 9dcb4a939a..0eeb406505 100644
--- a/structure/transports/responses.md
+++ b/structure/transports/responses.md
@@ -49,7 +49,7 @@ keep-alive reuse with `Connection: close` and `keepalive: false`; exact hosts an
 match case-insensitively. `sendWithConnectionPolicy` applies the policy around the fetch that
 performs the physical send, after a dispatch override has selected or rebuilt the destination, so
 matching follows the URL sent on the wire rather than the URL supplied before credential
-revalidation.
+revalidation. At this final HTTP boundary, native ChatGPT Responses and compact JSON strings of at least 1 MiB (UTF-8) become byte buffers to avoid Bun's large-string upload resets. Content, headers, abort signals and retry policy are preserved; WebSocket selection still receives the original string. Other destinations, small strings and existing byte/stream bodies retain their representation.

 The wrapped executor alone is not that boundary. An override that revalidates credentials re-reads
 `route.provider.fetch` at send time, because reselection can install a different provider transport
diff --git a/tests/responses/responses-fetch-helpers-boundary.test.ts b/tests/responses/responses-fetch-helpers-boundary.test.ts
index 1f59e4ef4b..3a1033a66f 100644
--- a/tests/responses/responses-fetch-helpers-boundary.test.ts
+++ b/tests/responses/responses-fetch-helpers-boundary.test.ts
@@ -3,12 +3,105 @@ import { readFileSync } from "node:fs";
 import { dirname, resolve } from "node:path";
 import { fileURLToPath } from "node:url";
 import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
-import { fetchWithHeaderTimeout, storedPoolReplayDispatchNotifier } from "../../src/server/responses/fetch-helpers";
+import { fetchWithHeaderTimeout, providerFetch, sendWithConnectionPolicy, storedPoolReplayDispatchNotifier } from "../../src/server/responses/fetch-helpers";
 import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

 const repoRoot = resolveRepoRoot();
 const helperPath = resolve(repoRoot, "src/server/responses/fetch-helpers.ts");

+describe("native Codex HTTP upload representation", () => {
+  const endpoint = "https://chatgpt.com/backend-api/codex/responses";
+
+  function captureFetch() {
+    const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = [];
+    const execute = (async (input, init) => {
+      calls.push({ input, init });
+      return new Response("ok");
+    }) as typeof fetch;
+    return { calls, execute };
+  }
+
+  test("sends large Unicode JSON as identical UTF-8 bytes without changing request metadata", async () => {
+    // Fewer than 1 MiB of JS code units, but over 1 MiB on the wire.
+    const body = JSON.stringify({ input: "é🦊".repeat(200_000) });
+    const signal = new AbortController().signal;
+    const headers = { "content-type": "application/json", "x-request-test": "preserved" };
+    const init: RequestInit = { method: "POST", body, headers, signal };
+    const capture = captureFetch();
+
+    await sendWithConnectionPolicy(capture.execute, endpoint, init);
+
+    expect(capture.calls).toHaveLength(1);
+    const sent = capture.calls[0]!;
+    expect(sent.input).toBe(endpoint);
+    expect(sent.init?.body instanceof Uint8Array).toBe(true);
+    expect(Buffer.from(sent.init!.body as Uint8Array).equals(Buffer.from(body, "utf8"))).toBe(true);
+    expect(sent.init?.method).toBe("POST");
+    expect(sent.init?.signal).toBe(signal);
+    expect(Object.fromEntries(new Headers(sent.init?.headers))).toEqual(headers);
+    expect(sent.init?.redirect).toBe("manual");
+    expect(init.body).toBe(body);
+  });
+
+  test("covers compact and rebuilt destinations at the final HTTP dispatch", async () => {
+    const body = JSON.stringify({ input: "x".repeat(1024 * 1024) });
+    const capture = captureFetch();
+    const send = providerFetch({ adapter: "openai-responses", baseUrl: "https://gateway.example/v1", fetch: capture.execute }, undefined, {
+      httpOnly: true,
+      dispatchOverride: (_input, init, execute) => execute(new URL(`${endpoint}/compact`), init),
+    });
+
+    await send("https://gateway.example/v1/responses", { method: "POST", body });
+
+    expect(capture.calls).toHaveLength(1);
+    expect(String(capture.calls[0]!.input)).toBe(`${endpoint}/compact`);
+    const sent = capture.calls[0]!.init?.body;
+    expect(sent instanceof Uint8Array).toBe(true);
+    expect(Buffer.from(sent as Uint8Array).equals(Buffer.from(body, "utf8"))).toBe(true);
+  });
+
+  test("preserves small strings and already encoded bodies by identity", async () => {
+    const capture = captureFetch();
+    const bodies: BodyInit[] = ["{}", Buffer.alloc(1024 * 1024, 120), new Blob(["unchanged"]), new ReadableStream()];
+    for (const body of bodies) {
+      await sendWithConnectionPolicy(capture.execute, new Request(endpoint), { method: "POST", body });
+      expect(capture.calls.at(-1)!.init?.body).toBe(body);
+    }
+    expect(capture.calls).toHaveLength(bodies.length);
+  });
+
+  test("leaves other hosts, schemes, ports and endpoint paths unchanged", async () => {
+    const body = "x".repeat(1024 * 1024);
+    const capture = captureFetch();
+    for (const target of ["https://api.openai.com/v1/responses", "https://gateway.example/v1/responses",
+      "http://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com:8443/backend-api/codex/responses",
+      "https://chatgpt.com/backend-api/codex/models", "https://chatgpt.com/backend-api/codex/responses/other"]) {
+      await sendWithConnectionPolicy(capture.execute, target, { method: "POST", body });
+      expect(capture.calls.at(-1)!.init?.body).toBe(body);
+    }
+  });
+
+  test("nested dispatch preserves the encoded buffer and propagates failure without retry", async () => {
+    const body = "x".repeat(1024 * 1024);
+    const failure = Object.assign(new TypeError("test connection reset"), { code: "ECONNRESET" });
+    let calls = 0;
+    let encoded: BodyInit | null | undefined;
+    const physical = (async (_input, init) => {
+      calls += 1;
+      expect(init?.body).toBe(encoded);
+      throw failure;
+    }) as typeof fetch;
+    const nested = ((input, init) => {
+      encoded = init?.body;
+      expect(encoded instanceof Uint8Array).toBe(true);
+      return sendWithConnectionPolicy(physical, input, init);
+    }) as typeof fetch;
+
+    await expect(sendWithConnectionPolicy(nested, endpoint, { method: "POST", body })).rejects.toBe(failure);
+    expect(calls).toBe(1);
+  });
+});
+
 interface RuntimeImportScan {
   specifiers: string[];
   nonLiteralDynamicImports: string[];
```

## Additional regression obligations

MODIFY `tests/responses/responses-fetch-helpers-boundary.test.ts` in its native-upload describe block: parameterize ASCII bodies at 1 MiB minus one, exactly 1 MiB, and 1 MiB plus one; assert string identity below and exact byte identity at/above. Add a rejected AbortError case with an already-aborted signal and verify one executor invocation (not a physical network send), same signal, same rejection, and no retry. Existing fresh-connection and egress cases must remain green. Include a native-to-nonnative rebuilt-destination negative alongside the source nonnative-to-native compact case; final destination owns applicability.

Activation evidence: a multibyte JSON body below one MiB in JS code units but above one MiB in bytes must arrive at the capture fetch as identical Uint8Array bytes. Nested calls retain the same buffer and call the physical sender once on ECONNRESET. Exact host/path negatives remain strings. No endpoint or native-account behavior is inferred from this test double.

Verification command: `bun test tests/responses/responses-fetch-helpers-boundary.test.ts tests/responses/fresh-connection-optout.test.ts tests/responses/provider-egress-fetch.test.ts`. Baseline attempt on 2026-10-03 exited 1 before behavioral execution: zod/v4 dependency missing (0 pass, 3 loader errors); see `.tmp/release-stabilization/transport-baseline.log`. The command names all target files directly. After gate release, locked dependencies were installed (ignore-scripts) and the baseline passed 27 tests / 0 failures. Do not rerun unchanged baseline for confidence; source author evidence remains separate.

Run typecheck, privacy and structure before review readiness. Build docs-site after its locked install because user docs change. Full local suite exception: concurrent release worktrees share resources; focused regression scope is explicit, and applicable hosted PR CI remains mandatory. A synthetic live upload is optional feasibility work only, with no private conversation capture and no new paid resource; source author's macOS/Bun success is historical evidence, not our live proof.
