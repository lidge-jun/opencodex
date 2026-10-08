import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { completedPayload } from "../helpers/compaction-routing-fixtures";
import { providerEditorConfigDTO, parseProviderEditorConfigDTO } from "../../src/server/auth-cors";
import { getDefaultConfig } from "../../src/config";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, compactionRequest, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import * as destinations from "../../src/providers/openai-tiers-destination";
import type { OcxProviderConfig } from "../../src/types";
import { compactionItemToText, encodeCompactionSummary } from "../../src/responses/compaction";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

const gateway: OcxProviderConfig = {
  adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key",
  apiKey: "fixture-native-gateway",
};

const nativeBlob = "gateway-native-compaction-fixture";
const compactItem = { type: "compaction", encrypted_content: nativeBlob };
const nativeProvider = { ...gateway, supportsNativeCompactionTrigger: true, decodesNativeCompactionBlobs: true };

async function serialized(provider: OcxProviderConfig, portable = false, changed = false) {
  const input = [{ type: "message", role: "user", content: "Keep the task." }, compactItem, { type: "compaction_trigger" }];
  const raw = baseCompactionBody({ model: "some-model", input, store: false });
  const request = await createResponsesPassthroughAdapter(provider).buildRequest({
    modelId: "some-model", context: { messages: [] }, options: {}, stream: false,
    _rawBody: raw, _compactionRequest: true, _portableCompaction: portable,
    _stripReasoningEncryptedContent: changed,
  }, { headers: new Headers(), translatorBudget: createTranslatorBudget() });
  return JSON.parse(request.body);
}

describe("native gateway transport", () => {
  test("preserves the trigger, declared functions and explicit same-provider blob replay", async () => {
    const body = await serialized(nativeProvider);
    expect(body.input).toContainEqual({ type: "compaction_trigger" });
    expect(body.input).toContainEqual(compactItem);
    expect(body.tools).toMatchObject([{ type: "function", name: "shell" }]);
    expect(body.tool_choice).toBe("auto");
  });

  test("portable override still summarizes and serving-identity changes still strip ciphertext", async () => {
    const portable = await serialized(nativeProvider, true);
    expect(portable.input).not.toContainEqual({ type: "compaction_trigger" });
    expect(portable.tools).toBeUndefined();
    expect((await serialized(nativeProvider, false, true)).input).not.toContainEqual(compactItem);
    expect((await serialized({ ...nativeProvider, decodesNativeCompactionBlobs: false })).input).not.toContainEqual(compactItem);
    expect((await serialized({ ...gateway, supportsNativeCompactEndpoint: true })).tools).toBeUndefined();
  });

  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-native-compact-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    release?.();
    globalThis.fetch = originalFetch;
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  test("handler selects native passthrough instead of synthesizing ocx1 output", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: "resp_gateway", status: "completed", output: [compactItem] });
    }) as typeof fetch;
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: nativeProvider } };
    const response = await handleResponses(compactionRequest(baseCompactionBody()), config, { model: "", provider: "" });
    const payload = await response.json();
    expect({ status: response.status, payload }).toMatchObject({ status: 200, payload: { output: [compactItem] } });
    expect(sent.input).toContainEqual({ type: "compaction_trigger" });
    expect(sent.tools).toMatchObject([{ type: "function", name: "shell" }]);
    expect(payload.output).toEqual([compactItem]);
  });

  test.each([
    { authMode: "key" as const, baseUrl: "https://gateway.example/v1/responses/", path: "/v1/responses/compact" },
    { authMode: "key" as const, baseUrl: "https://gateway.example", responsesPath: "/custom/responses", path: "/custom/responses/compact" },
    { authMode: "forward" as const, baseUrl: "https://gateway.example/relay", path: "/relay/responses/compact" },
  ])("v1 uses custom transport URL and static auth: $authMode $path", async row => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(new Request(url, init));
      return Response.json({ object: "response.compaction", output: [compactItem] });
    }) as typeof fetch;
    const provider = { ...gateway, ...row, supportsNativeCompactEndpoint: true,
      headers: { Authorization: "Bearer static-fixture", "x-gateway-fixture": "native-compact" },
      forwardClientHeaders: ["originator"],
    };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody(), undefined, {
      authorization: "Bearer caller-fixture", "chatgpt-account-id": "caller-account-fixture",
      originator: "gateway-client-fixture",
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect((await response.json()).output).toEqual([compactItem]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(row.path);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer static-fixture");
    expect(calls[0]!.headers.get("x-gateway-fixture")).toBe("native-compact");
    expect(calls[0]!.headers.get("originator")).toBe("gateway-client-fixture");
    expect(calls[0]!.headers.has("chatgpt-account-id")).toBe(false);
    expect((await calls[0]!.json()).model).toBe("some-model");
  });

  test.each([
    { replay: undefined, blob: nativeBlob },
    { replay: true, blob: encodeCompactionSummary("Portable retained task fixture.") },
    { replay: true, blob: nativeBlob },
  ])("v1 normalizes replay independently of endpoint capability: $replay $blob", async row => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ object: "response.compaction", output: [compactItem] });
    }) as typeof fetch;
    const provider = { ...gateway, supportsNativeCompactEndpoint: true,
      ...(row.replay === undefined ? {} : { decodesNativeCompactionBlobs: row.replay }),
    };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const input = [{ type: "compaction", encrypted_content: row.blob }];
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ input })), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(sent.input).toEqual(row.replay && row.blob === nativeBlob ? input : [{
      type: "message", role: "user", content: [{ type: "input_text", text: compactionItemToText(row.blob) }],
    }]);
    await response.text();
  });

  test.each([{ change: "model" }, { change: "destination" }, { change: "credential" }])("v1 refuses native replay after a known serving $change change", async ({ change }) => {
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(completedPayload("Task fixture."));
    }) as typeof fetch;
    const provider = { ...nativeProvider, supportsNativeCompactEndpoint: true };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const headers = { "thread-id": `v1-replay-${change}-fixture` };
    const first = await handleResponses(compactionRequest(baseCompactionBody({ input: [{ role: "user", content: "Task fixture." }] }), undefined, headers), config, { model: "", provider: "" });
    expect(first.status).toBe(200);
    await first.text();
    if (change === "destination") provider.baseUrl = "https://other-gateway.example/v1";
    if (change === "credential") provider.apiKey = "different-key-fixture";
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({
      model: change === "model" ? "gw/other-model" : "gw/some-model", input: [compactItem],
    }), undefined, headers), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual([{
      type: "message", role: "user", content: [{ type: "input_text", text: compactionItemToText(nativeBlob) }],
    }]);
    await response.text();
  });

  test.each([true, false])("v1 shares parent-thread replay provenance with v2: child header %s", async withChild => {
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_parent_fixture", status: "completed", output: [compactItem] });
    }) as typeof fetch;
    const provider = { ...nativeProvider, supportsNativeCompactEndpoint: true };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const headers = { "x-codex-parent-thread-id": ` parent-replay-${withChild}-fixture `,
      ...(withChild ? { "thread-id": "child-replay-fixture" } : {}), session_id: "shared-cohort-fixture" };
    const first = await handleResponses(compactionRequest(baseCompactionBody(), undefined, headers), config, { model: "", provider: "" });
    expect((await first.json()).output).toEqual([compactItem]);
    provider.apiKey = "parent-key-b-fixture";
    const compact = await handleResponsesCompact(compactionRequest(baseCompactionBody({ input: [compactItem] }), undefined, headers), config, { model: "", provider: "" });
    expect((await compact.json()).output).toEqual([compactItem]);
    expect(calls[1]!.input).toEqual([{
      type: "message", role: "user", content: [{ type: "input_text", text: compactionItemToText(nativeBlob) }],
    }]);
    // A successful v1 under B must update the same scope ordinary Responses reads.
    const ordinary = await handleResponses(compactionRequest(baseCompactionBody({ input: [compactItem] }), undefined, headers), config, { model: "", provider: "" });
    expect((await ordinary.json()).output).toEqual([compactItem]);
    expect(calls[2]!.input).toContainEqual(compactItem);
    provider.apiKey = gateway.apiKey;
    const rebound = await handleResponses(compactionRequest(baseCompactionBody({ input: [compactItem] }), undefined, headers), config, { model: "", provider: "" });
    expect((await rebound.json()).output).toEqual([compactItem]);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.input).not.toContainEqual(compactItem);
  });

  test.each([true, false])("v1 sanitizes reasoning replay after a serving credential change: %s", async changed => {
    const calls: Record<string, unknown>[] = [];
    const reasoning = { type: "reasoning", id: "rs_gateway_fixture", summary: [{ type: "summary_text", text: "Retained reasoning fixture." }], encrypted_content: "reasoning-ciphertext-fixture" };
    const idOnly = { type: "reasoning", id: "rs_id_only_fixture", summary: [] };
    globalThis.fetch = (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_reasoning_fixture", status: "completed", output: [reasoning, compactItem] });
    }) as typeof fetch;
    const provider = { ...nativeProvider, supportsNativeCompactEndpoint: true };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const headers = { "thread-id": `reasoning-replay-${changed}-fixture` };
    const first = await handleResponses(compactionRequest(baseCompactionBody(), undefined, headers), config, { model: "", provider: "" });
    expect((await first.json()).output).toEqual([reasoning, compactItem]);
    if (changed) provider.apiKey = "reasoning-key-b-fixture";
    const compact = await handleResponsesCompact(compactionRequest(baseCompactionBody({ input: [reasoning, idOnly, compactItem] }), undefined, headers), config, { model: "", provider: "" });
    expect((await compact.json()).output).toEqual([reasoning, compactItem]);
    expect(calls).toHaveLength(2);
    const input = calls[1]!.input as Record<string, unknown>[];
    expect(input[0]).toEqual(changed ? { type: "reasoning", summary: reasoning.summary } : reasoning);
    expect(input[1]).toEqual(changed ? { type: "reasoning", summary: [] } : idOnly);
    expect(input[2]).toEqual(changed ? {
      type: "message", role: "user", content: [{ type: "input_text", text: compactionItemToText(nativeBlob) }],
    } : compactItem);
  });

  test.each([true, false])("custom v1 strips private top-level fields with endpoint enabled %s", async native => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      const call = new Request(url, init);
      calls.push(call.clone());
      const body = await call.json();
      if ("access_programs" in body) return Response.json({ error: { message: "Unknown access_programs fixture." } }, { status: 400 });
      return String(url).endsWith("/compact") ? Response.json({ object: "response.compaction", output: [compactItem] })
        : Response.json(completedPayload("Strict gateway retained task fixture."));
    }) as typeof fetch;
    const provider = { ...gateway, supportsNativeCompactEndpoint: native };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({
      access_programs: { cyber: "standard" }, unlisted_fixture_option: "preserved",
    })), config, { model: "", provider: "" });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(Array.isArray(payload.output)).toBe(true);
    expect(JSON.stringify(payload)).toContain(native ? nativeBlob : "Strict gateway retained task fixture.");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(native ? "/v1/responses/compact" : "/v1/responses");
    const sent = await calls[0]!.json();
    expect(sent).not.toHaveProperty("access_programs");
    expect(sent.unlisted_fixture_option).toBe("preserved");
  });

  test.each([
    { label: "canonical", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const },
    { label: "official API", baseUrl: "https://api.openai.com/v1", authMode: "key" as const },
  ])("native v1 preserves official private top-level fields: $label", async row => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(new Request(url, init));
      return Response.json({ object: "response.compaction", output: [compactItem] });
    }) as typeof fetch;
    const providerName = row.authMode === "key" ? "openai-apikey" : "gw";
    const config = { ...getDefaultConfig(), defaultProvider: providerName, providers: { [providerName]: { ...gateway, ...row } } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({
      model: `${providerName}/some-model`,
      access_programs: { cyber: "standard" },
    }), undefined, { authorization: "Bearer official-caller-fixture" }), config, { model: "", provider: "" });
    expect((await response.json()).output).toEqual([compactItem]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${row.baseUrl}/responses/compact`);
    expect((await calls[0]!.json()).access_programs).toEqual({ cyber: "standard" });
  });

  test.each([true, false])("custom Daybreak model uses endpoint capability, not canonical restrictions: %s", async native => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(new Request(url, init));
      return native ? Response.json({ object: "response.compaction", output: [compactItem] })
        : Response.json(completedPayload("Daybreak task fixture."));
    }) as typeof fetch;
    const provider = { ...gateway, supportsNativeCompactEndpoint: native };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({
      model: "gw/gpt-daybreak-blue-latest", stream: false,
    })), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(native ? "/v1/responses/compact" : "/v1/responses");
    expect(await calls[0]!.json()).toMatchObject({ model: "gpt-daybreak-blue-latest", stream: false });
    await response.text();
  });

  test.each(["key", "forward"] as const)("v1 404 fallback preserves fingerprint without caller credentials: %s", async authMode => {
    const calls: Request[] = [];
    globalThis.fetch = (async (url, init) => {
      calls.push(new Request(url, init));
      return String(url).endsWith("/compact") ? Response.json({ error: { message: "Missing endpoint fixture." } }, { status: 404 })
        : Response.json(completedPayload("Fallback summary fixture."));
    }) as typeof fetch;
    const provider = { ...gateway, authMode, supportsNativeCompactEndpoint: true,
      headers: { Authorization: "Bearer static-fixture" },
      // Runtime must reject credential opt-ins even if an unvalidated row reaches dispatch.
      forwardClientHeaders: ["X-Codex-App-Version", "originator", "x-client-request-id", "authorization", "chatgpt-account-id", "x-api-key", "cookie", "x-oai-attestation"],
    };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const fingerprint = { "user-agent": "CodexFixture/1.0", "x-codex-app-version": "fixture-version", originator: "fixture-origin", "x-client-request-id": "fixture-request" };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody(), undefined, {
      ...fingerprint, authorization: "Bearer caller-fixture", "chatgpt-account-id": "caller-account-fixture",
      "x-api-key": "caller-key-fixture", cookie: "caller-cookie-fixture", "x-oai-attestation": "caller-attestation-fixture",
      "x-unconfigured-client": "not-forwardable-fixture",
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/v1/responses/compact", "/v1/responses"]);
    for (const call of calls) {
      for (const [name, value] of Object.entries(fingerprint)) expect(call.headers.get(name)).toBe(value);
      expect(call.headers.get("authorization")).toBe("Bearer static-fixture");
      for (const name of ["chatgpt-account-id", "x-api-key", "cookie", "x-oai-attestation", "x-unconfigured-client"]) expect(call.headers.has(name)).toBe(false);
    }
    await response.text();
  });

  test.each([
    { label: "custom configured one", policy: { enabled: true, attempts: 1 }, canonical: false, used: 0, expected: 1 },
    { label: "custom configured total", policy: { enabled: true, attempts: 2 }, canonical: false, used: 1, expected: 1 },
    { label: "custom default", policy: undefined, canonical: false, used: 0, expected: 3 },
    { label: "custom disabled", policy: { enabled: false, attempts: 1 }, canonical: false, used: 0, expected: 3 },
    { label: "canonical retains ladder", policy: { enabled: true, attempts: 1 }, canonical: true, used: 0, expected: 3 },
  ])("v1 transient retry honors key-auth policy and shared budget: $label", async row => {
    let sends = 0;
    globalThis.fetch = (async (_url, _init) => {
      sends += 1;
      return Response.json({ error: { message: "Unavailable fixture." } }, { status: 503 });
    }) as typeof fetch;
    const provider: OcxProviderConfig = { ...gateway, supportsNativeCompactEndpoint: true,
      ...(row.canonical ? { baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } : {}),
      transientRetryOn5xx: row.policy,
    };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const sendBudget = createRequestExecutionBudget();
    sendBudget.used = row.used;
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody()), config, { model: "", provider: "" }, undefined, undefined, { sendBudget });
    expect(response.status).toBe(503);
    expect(sends).toBe(row.expected);
    expect(sendBudget.used).toBe(row.used + row.expected);
    await response.text();
  });

  test("v2-only opt-in keeps the v1 fallback portable", async () => {
    const paths: string[] = [];
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      sent = JSON.parse(String(init?.body));
      return Response.json(completedPayload("Keep the task state."));
    }) as typeof fetch;
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: nativeProvider } };
    const response = await handleResponsesCompact(compactionRequest(baseCompactionBody()), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(paths).toEqual(["/v1/responses"]);
    expect(sent.input).not.toContainEqual({ type: "compaction_trigger" });
    expect(sent.tools).toBeUndefined();
    expect(JSON.stringify(await response.json())).toContain("Keep the task state.");
  });

  test.each(["responses", "compact"])("cross-provider override forces portable summarization: %s", async endpoint => {
    let sent: Record<string, unknown> = {};
    const paths: string[] = [];
    globalThis.fetch = (async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      sent = JSON.parse(String(init?.body));
      return Response.json(completedPayload("Portable summary fixture."));
    }) as typeof fetch;
    const config = { ...getDefaultConfig(), defaultProvider: "source", providers: {
      source: gateway, gw: { ...nativeProvider, supportsNativeCompactEndpoint: true },
    }, compactionRouting: { model: "gw/some-model" } };
    const req = compactionRequest(baseCompactionBody({ model: "source/some-model", store: false }), undefined, {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }),
    });
    const response = await (endpoint === "compact" ? handleResponsesCompact : handleResponses)(req, config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(paths).toEqual(["/v1/responses"]);
    expect(sent.input).not.toContainEqual({ type: "compaction_trigger" });
    expect(sent.tools).toBeUndefined();
    await response.text();
  });

  test.each(["supportsNativeCompactionTrigger", "supportsNativeCompactEndpoint"] as const)("v2 recovery eligibility follows trigger capability, not endpoint: %s", async flag => {
    const paths: string[] = [];
    globalThis.fetch = (async (url) => {
      paths.push(String(url));
      return String(url).includes("gateway.example")
        ? Response.json({ error: { code: "context_length_exceeded", message: "Fixture overflow" } }, { status: 400 })
        : Response.json(completedPayload("Recovered portable fixture."));
    }) as typeof fetch;
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: {
      gw: { ...gateway, [flag]: true },
      emergency: { ...gateway, baseUrl: "https://emergency.example/v1" },
    }, compactionRecovery: { enabled: true, model: "emergency/rescue" } };
    const response = await handleResponses(compactionRequest(baseCompactionBody({ store: false })), config, { model: "", provider: "" });
    await response.text();
    expect(paths).toHaveLength(flag === "supportsNativeCompactionTrigger" ? 1 : 2);
  });
});

// Independent protocol claims must never grant official identity or credential authority.
describe("native gateway compaction capabilities", () => {
  test("editor projection round-trips non-secret protocol capabilities without credentials", () => {
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: {
      gw: { ...nativeProvider, supportsNativeCompactEndpoint: true },
    } };
    const dto = providerEditorConfigDTO(config);
    expect(dto.providers.gw).toMatchObject({ supportsNativeCompactionTrigger: true, supportsNativeCompactEndpoint: true });
    expect(dto.providers.gw).not.toHaveProperty("apiKey");
    expect(parseProviderEditorConfigDTO(dto).ok).toBe(true);
  });
  test("defaults remain routed and each opt-in is independent", () => {
    const trigger = (destinations as unknown as {
      supportsNativeResponsesCompactionTrigger: (provider: OcxProviderConfig) => boolean;
    }).supportsNativeResponsesCompactionTrigger;
    expect(typeof trigger).toBe("function");
    expect(trigger(gateway)).toBe(false);
    expect(destinations.supportsNativeResponsesCompactEndpoint("gw", gateway)).toBe(false);
    for (const adapter of ["openai-responses", "openai-chat"] as const) {
      const v2 = { ...gateway, adapter, supportsNativeCompactionTrigger: true };
      const v1 = { ...gateway, adapter, supportsNativeCompactEndpoint: true };
      expect(trigger(v2)).toBe(adapter === "openai-responses");
      expect(trigger(v1)).toBe(false);
      expect(destinations.supportsNativeResponsesCompactEndpoint("gw", v1)).toBe(adapter === "openai-responses");
      expect(destinations.supportsNativeResponsesCompactEndpoint("gw", v2)).toBe(false);
      for (const row of [v1, v2]) {
        expect(destinations.isCanonicalOpenAiForwardProvider(row)).toBe(false);
        expect(destinations.isOpenAiOperatedResponsesDestination(row)).toBe(false);
        expect(destinations.destinationDecodesNativeCompactionBlob(row)).toBe(false);
      }
    }
    expect(trigger({ ...gateway, baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" })).toBe(true);
    expect(trigger({ ...gateway, baseUrl: "https://api.openai.com/v1" })).toBe(false);
  });

  test("schema preserves booleans and rejects unknown values rather than coercing", () => {
    for (const field of ["supportsNativeCompactionTrigger", "supportsNativeCompactEndpoint"]) {
      for (const value of [true, false]) {
        expect(providerConfigSchema.parse({ ...gateway, [field]: value })).toHaveProperty(field, value);
      }
      expect(providerConfigSchema.parse(gateway)).not.toHaveProperty(field);
      for (const value of ["true", "false", 0, 1, null, {}, []]) {
        expect(providerConfigSchema.safeParse({ ...gateway, [field]: value }).success).toBe(false);
      }
    }
  });
});
