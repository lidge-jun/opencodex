import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearReasoningReplayCacheForTests, commitReasoningReplayServingIdentity,
  getReasoningReplayOpaqueBlobRejection, nativeReasoningTag,
  peekReasoningForCall, reasoningReplayServingIdentityChanged,
  rememberReasoningForCall, rememberReasoningReplayOpaqueBlobRejection,
} from "../../src/responses/reasoning-replay-cache";
import { parseRequest } from "../../src/responses/parser";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { bindRouteReasoningReplayScope, mandatoryResponsesReasoningReplayUnavailable,
  nativeReasoningOwnerForRoute } from "../../src/server/responses/core-replay";
import { handleResponses } from "../../src/server/responses/core";
import { resolveResponsesApiAuth } from "../../src/server/auth-cors";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
const THREAD = "synthetic-shared-thread";
const BLOB = "synthetic-opaque-reasoning";
let home: string;
let releaseSpend: (() => void) | undefined;
const provider = (name: string): OcxProviderConfig => ({
  adapter: "openai-responses", baseUrl: `https://${name}.example.test/v1`,
  authMode: "key", apiKey: `synthetic-${name}`, decodesNativeCompactionBlobs: true,
});
function bound(principal?: string, name = "first", thread = THREAD) {
  const parsed = parseRequest({ model: "model-a", input: "synthetic" });
  parsed._reasoningReplayScope = { clientThreadId: thread, clientPrincipalId: principal };
  bindRouteReasoningReplayScope({ parsed, providerName: name, provider: provider(name), adapterName: "openai-responses" });
  return parsed;
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-replay-principal-"));
  process.env.OPENCODEX_HOME = home;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
});
afterEach(() => {
  releaseSpend?.(); releaseSpend = undefined;
  globalThis.fetch = originalFetch;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test.each(["principal-b", undefined])("a foreign serving commit cannot alter principal A's provenance (%s)", other => {
  const a = bound("principal-a");
  commitReasoningReplayServingIdentity(a._reasoningReplayScope);
  commitReasoningReplayServingIdentity(bound(other, "second")._reasoningReplayScope);
  expect(bound("principal-a")._stripReasoningEncryptedContent).not.toBe(true);
  const changed = bound("principal-a", "second");
  expect(changed._stripReasoningEncryptedContent).toBe(true);
  expect(changed._dropForeignReasoningItemIds).toBe(true);
  expect(bound(other, "second")._stripReasoningEncryptedContent).not.toBe(true);
});

test("keyless physical safeguards remain independent of authenticated callers", () => {
  const keyless = bound();
  expect(keyless._reasoningReplayScope?.current).toBeDefined();
  commitReasoningReplayServingIdentity(keyless._reasoningReplayScope);
  commitReasoningReplayServingIdentity(bound("principal-a", "second")._reasoningReplayScope);
  expect(bound()._stripReasoningEncryptedContent).not.toBe(true);
  expect(bound(undefined, "second")._stripReasoningEncryptedContent).toBe(true);
  rememberReasoningForCall("call", "private", bound("principal-a")._reasoningReplayScope);
  expect(peekReasoningForCall("call", keyless._reasoningReplayScope)).toBeUndefined();
  rememberReasoningForCall("call", "keyless", keyless._reasoningReplayScope);
  expect(peekReasoningForCall("call", keyless._reasoningReplayScope)).toBeUndefined();
});

test.each([false, true])("rejection memo stays in its principal namespace (selective=%s)", selective => {
  const a = bound("principal-a");
  const fingerprints = selective ? new Set(["a".repeat(64)]) : undefined;
  rememberReasoningReplayOpaqueBlobRejection(a._reasoningReplayScope, fingerprints);
  expect(getReasoningReplayOpaqueBlobRejection(a._reasoningReplayScope)?.mode).toBe(selective ? "selective" : "blanket");
  expect(getReasoningReplayOpaqueBlobRejection(bound("principal-b")._reasoningReplayScope)).toBeUndefined();
  expect(getReasoningReplayOpaqueBlobRejection(bound()._reasoningReplayScope)).toBeUndefined();
  rememberReasoningReplayOpaqueBlobRejection(bound()._reasoningReplayScope);
  expect(getReasoningReplayOpaqueBlobRejection(bound()._reasoningReplayScope)?.mode).toBe("blanket");
  expect(getReasoningReplayOpaqueBlobRejection(bound("principal-b")._reasoningReplayScope)).toBeUndefined();
});

test("principal and thread tuple encoding is unambiguous", () => {
  const a = bound('a","b', "first", "c");
  commitReasoningReplayServingIdentity(a._reasoningReplayScope);
  expect(reasoningReplayServingIdentityChanged(bound("a", "second", 'b","c')._reasoningReplayScope)).toBe(false);
  expect(reasoningReplayServingIdentityChanged(bound('a","b', "second", "c")._reasoningReplayScope)).toBe(true);
});

test.each(["principal-a", undefined])("strict Combo eligibility checks its own serving namespace (%s)", principal => {
  commitReasoningReplayServingIdentity(bound(principal)._reasoningReplayScope);
  const args = {
    body: { tools: [{}], input: [{ type: "reasoning", encrypted_content: BLOB }] },
    clientThreadId: THREAD, clientPrincipalId: principal, providerName: "second",
    provider: { ...provider("second"), preserveResponsesReasoningContent: true, requiresAdjacentResponsesToolResults: true },
    adapterName: "openai-responses", modelId: "model-a",
  };
  expect(mandatoryResponsesReasoningReplayUnavailable(args)).toBe(true);
  expect(mandatoryResponsesReasoningReplayUnavailable({ ...args, clientPrincipalId: "foreign-principal" })).toBe(false);
});

test("a foreign owner tag still strips a blob regardless of principal metadata", () => {
  const parsed = bound("principal-a");
  const raw = { input: [{ type: "reasoning", encrypted_content: BLOB }] };
  parsed._rawBody = raw;
  const owner = nativeReasoningOwnerForRoute({ provider: provider("second") });
  const tag = nativeReasoningTag(owner, BLOB);
  expect(tag).toBeDefined();
  parsed._nativeReasoningReplay = new Map([[BLOB, tag!]]);
  bindRouteReasoningReplayScope({ parsed, providerName: "first", provider: provider("first"), adapterName: "openai-responses" });
  expect(raw.input[0]!.encrypted_content).toBeUndefined();
});

test("HTTP handler keeps recovery memoization for the admitted principal only", async () => {
  releaseSpend = acquireOwnedSpendHome();
  const config = { port: 0, hostname: "127.0.0.1", defaultProvider: "first",
    apiKeys: ["a", "b"].map(id => ({ id, name: id, key: `synthetic-caller-${id}`, createdAt: "2026-01-01" })),
    providers: { first: provider("first") },
  } as OcxConfig;
  const sent: boolean[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toStartWith("https://first.example.test/");
    const hasBlob = String(init?.body).includes(BLOB);
    sent.push(hasBlob);
    if (hasBlob) return Response.json({ error: { message: "The encrypted content could not be verified.",
      type: "invalid_request_error", code: "invalid_encrypted_content" } }, { status: 400 });
    return Response.json({ id: `resp-${sent.length}`, object: "response", status: "completed", model: "model-a", output: [] });
  }) as typeof fetch;
  for (const caller of ["a", "a", "b", undefined, undefined]) {
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: {
      "content-type": "application/json", "thread-id": THREAD,
      ...(caller ? { "x-opencodex-api-key": `synthetic-caller-${caller}` } : {}),
    }, body: JSON.stringify({ model: "first/model-a", stream: false, store: false, input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "before" }] },
      { type: "reasoning", content: [], summary: [], encrypted_content: BLOB },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ] }) });
    const admission = resolveResponsesApiAuth(req, { hostname: "127.0.0.1", apiKeys: config.apiKeys });
    expect(admission?.kind).toBe("loopback");
    const response = await handleResponses(req, config, { model: "", provider: "" }, { admission: admission! });
    expect(response.status).toBe(200);
    await response.text();
  }
  // Same-principal and same-keyless follow-ups strip preflight; each new namespace first recovers once.
  expect(sent).toEqual([true, false, false, true, false, true, false, false]);
});
