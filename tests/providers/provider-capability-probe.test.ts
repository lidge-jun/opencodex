import { describe, expect, test } from "bun:test";
import { chat, fixture, frame } from "../helpers/provider-completion-fixture";
import { handleProviderCapabilityProbeRoute } from "../../src/server/management/provider-capability-probe";
import { COMPLETION_TEST_IMAGE_DATA_URL, COMPLETION_TEST_PROMPT } from "../../src/server/management/provider-completion-test";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Respond = (body: Record<string, any>, init?: RequestInit) => Response | Promise<Response>;
const ok = () => new Response(chat());
const status = (code: number) => new Response(JSON.stringify({ error: { message: "upstream detail sk-fixture" } }), { status: code });
const isImage = (body: Record<string, any>) => Array.isArray(body.messages?.[0]?.content) || Array.isArray(body.input);
const effortOf = (body: Record<string, any>): string | undefined => body.reasoning_effort ?? body.reasoning?.effort;

const isBaseline = (body: Record<string, any>) => !isImage(body) && effortOf(body) === undefined;
function probeFixture(respond: Respond, overrides: Partial<OcxProviderConfig> = {}, baselineRespond: Respond = ok) {
  const f = fixture({ models: ["test-model"], ...overrides }, init => {
    const body = JSON.parse(String(init?.body));
    return isBaseline(body) ? baselineRespond(body, init) : respond(body, init);
  });
  const saves: OcxConfig[] = [];
  let convergences = 0;
  const probe = async (body: unknown, probeDeps = {}) => {
    const req = new Request("http://127.0.0.1/api/providers/probe-capabilities", {
      method: "POST", headers: { Host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = await handleProviderCapabilityProbeRoute({
      req, config: f.config,
      deps: { saveConfigPreservingClaudeCode: config => { saves.push(JSON.parse(JSON.stringify(config))); } },
      convergeCodexCatalog: async () => { convergences++; return { status: "committed", changed: false, degraded: false, notices: [] }; },
    }, probeDeps);
    return { status: response.status, body: await response.json() as any };
  };
  return { ...f, saves, probe, convergences: () => convergences };
}
// The first call is always the plain baseline prompt.
const bodies = (calls: { init?: RequestInit }[]) => calls.slice(1).map(call => JSON.parse(String(call.init!.body)));

describe("capability probe: gates", () => {
  test("metered provider without confirmation sends nothing and reports the plan", async () => {
    const f = probeFixture(ok);
    expect(await f.probe({ name: "fixture", model: "test-model", efforts: ["low", "high"] })).toEqual({ status: 200,
      body: { applicable: true, sent: false, requiresConfirmation: true, metered: true, plannedRequests: 4 } });
    expect(f.calls).toHaveLength(0);
  });
  test("local destination is not metered and needs no confirmation", async () => {
    const f = probeFixture(ok, { baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true });
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["image"] });
    expect(result.body).toMatchObject({ applicable: true, sent: true, metered: false, baseline: { status: "accepted" }, image: { status: "accepted" } });
    expect(f.calls).toHaveLength(2);
  });
  for (const [overrides, reason] of [[{ authMode: "oauth" }, "oauth_auth"], [{ authMode: "forward" }, "forward_auth"],
    [{ disabled: true }, "disabled"], [{ adapter: "anthropic" }, "unsupported_adapter"]] as const) {
    test(`${reason} is not applicable and sends nothing`, async () => {
      const f = probeFixture(ok, overrides as Partial<OcxProviderConfig>);
      const result = await f.probe({ name: "fixture", model: "test-model", confirmMetered: true });
      expect(result.body).toMatchObject({ applicable: false, reason, sent: false });
      expect(f.calls).toHaveLength(0);
    });
  }
  const invalid: unknown[] = [null, [], {}, { name: "fixture" }, { model: "test-model" }, { name: "fixture", model: " " },
    { name: "fixture", model: "a\nb" }, { name: "fixture", model: "x".repeat(257) }, { name: "fixture", model: "m", extra: 1 },
    { name: "fixture", model: "m", checks: [] }, { name: "fixture", model: "m", checks: ["video"] },
    { name: "fixture", model: "m", efforts: ["turbo"] }, { name: "fixture", model: "m", efforts: [] },
    { name: "fixture", model: "m", efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { name: "fixture", model: "m", checks: ["image"], efforts: ["low"] }, { name: "fixture", model: "m", apply: "yes" },
    { name: "fixture", model: "m", confirmMetered: 1 }, { name: "fixture", model: "__proto__", apply: true }];
  for (const [index, body] of invalid.entries()) test(`invalid body ${index}: 400 and no send`, async () => {
    const f = probeFixture(ok);
    expect((await f.probe(body)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  test("unknown provider is 404", async () => {
    const f = probeFixture(ok);
    expect(await f.probe({ name: "absent", model: "m" })).toEqual({ status: 404, body: { error: "unknown provider" } });
  });
});

describe("capability probe: wire variants and classification", () => {
  test("chat image variant and reasoning_effort ride the completion-test body", async () => {
    const f = probeFixture(body => isImage(body) ? ok() : status(400));
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["high"], confirmMetered: true });
    expect(result.body).toEqual({ applicable: true, sent: true, metered: true, provider: "fixture", model: "test-model",
      baseline: { status: "accepted" }, image: { status: "accepted" }, reasoning: { accepted: [], rejected: ["high"], inconclusive: [] } });
    const [image, reasoning] = bodies(f.calls);
    expect(image.messages).toEqual([{ role: "user", content: [{ type: "text", text: COMPLETION_TEST_PROMPT },
      { type: "image_url", image_url: { url: COMPLETION_TEST_IMAGE_DATA_URL } }] }]);
    expect(image.max_tokens).toBe(32);
    expect(reasoning).toMatchObject({ messages: [{ role: "user", content: COMPLETION_TEST_PROMPT }], reasoning_effort: "high" });
    expect(JSON.stringify(result.body)).not.toContain("upstream detail");
  });
  test("responses wire uses input_image and reasoning.effort", async () => {
    const done = frame({ type: "response.output_text.delta", delta: "OK" }) + frame({ type: "response.completed", response: {} });
    const f = probeFixture(() => new Response(done), { modelAdapters: { "test-model": "openai-responses" } }, () => new Response(done));
    await f.probe({ name: "fixture", model: "test-model", efforts: ["low"], confirmMetered: true });
    const [image, reasoning] = bodies(f.calls);
    expect(image.input).toEqual([{ role: "user", content: [{ type: "input_text", text: COMPLETION_TEST_PROMPT },
      { type: "input_image", image_url: COMPLETION_TEST_IMAGE_DATA_URL }] }]);
    expect(reasoning).toMatchObject({ input: COMPLETION_TEST_PROMPT, reasoning: { effort: "low" }, max_output_tokens: 32 });
  });
  test("image 422 is rejected with code and status only", async () => {
    const f = probeFixture(() => status(422));
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["image"], confirmMetered: true });
    expect(result.body.image).toEqual({ status: "rejected", error: { code: "http_status", status: 422 } });
  });
  test("image timeout is inconclusive", async () => {
    const hang: Respond = (_body, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const f = probeFixture(hang);
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["image"], confirmMetered: true }, { timeoutMs: 30 });
    expect(result.body.image).toEqual({ status: "inconclusive", error: { code: "timeout" } });
    // A baseline that times out makes every variant inconclusive without sending it.
    const g = probeFixture(ok, {}, hang);
    const blocked = await g.probe({ name: "fixture", model: "test-model", checks: ["image"], confirmMetered: true }, { timeoutMs: 30 });
    expect(blocked.body).toMatchObject({ baseline: { status: "inconclusive", error: { code: "timeout" } }, image: { status: "inconclusive" } });
    expect(g.calls).toHaveLength(1);
  });
  test("reasoning mix: no_content counts as accepted, 400 rejected, 5xx inconclusive", async () => {
    const f = probeFixture(body => effortOf(body) === "low" ? ok()
      : effortOf(body) === "medium" ? new Response(frame({ model: "test-model", choices: [{ delta: {}, finish_reason: "length" }] }) + frame("[DONE]"))
      : effortOf(body) === "high" ? status(400) : status(503));
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["reasoning"],
      efforts: ["xhigh", "high", "medium", "low"], confirmMetered: true });
    expect(result.body.reasoning).toEqual({ accepted: ["low", "medium"], rejected: ["high"], inconclusive: ["xhigh"] });
    expect(bodies(f.calls).map(effortOf)).toEqual(["low", "medium", "high", "xhigh"]);
  });
  test("401 stops early and marks the rest inconclusive", async () => {
    const f = probeFixture(body => isImage(body) ? ok() : status(401));
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["low", "medium", "high"], confirmMetered: true });
    expect(result.body.reasoning).toEqual({ accepted: [], rejected: [], inconclusive: ["low", "medium", "high"] });
    expect(f.calls).toHaveLength(3);
  });
  test("a 400 on the plain baseline is not blamed on the variant: nothing is rejected or applied", async () => {
    const f = probeFixture(() => status(400), {}, () => status(400));
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["low"], confirmMetered: true, apply: true });
    expect(result.body).toMatchObject({ baseline: { status: "rejected", error: { code: "http_status", status: 400 } },
      image: { status: "inconclusive" }, reasoning: { accepted: [], rejected: [], inconclusive: ["low"] }, applied: {} });
    expect(f.calls).toHaveLength(1);
    expect(f.saves).toHaveLength(0);
  });
  test("a textless completed baseline admits the request, so the requested variants still run", async () => {
    const textless = () => new Response(frame({ model: "test-model", choices: [{ delta: {}, finish_reason: "length" }] }) + frame("[DONE]"));
    const f = probeFixture(ok, {}, textless);
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["reasoning"], efforts: ["low", "high"], confirmMetered: true });
    expect(result.body).toMatchObject({ baseline: { status: "accepted" }, reasoning: { accepted: ["low", "high"], rejected: [], inconclusive: [] } });
    expect(f.calls).toHaveLength(3);
  });
  test("default efforts come from the model's configured ladder", async () => {
    const f = probeFixture(ok, { modelReasoningEfforts: { "test-model": ["high", "low"] } });
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["reasoning"], confirmMetered: true });
    expect(result.body.reasoning.accepted).toEqual(["low", "high"]);
  });
});

describe("capability probe: apply", () => {
  test("without apply nothing is written", async () => {
    const f = probeFixture(ok);
    await f.probe({ name: "fixture", model: "test-model", efforts: ["low"], confirmMetered: true });
    expect(f.saves).toHaveLength(0);
    expect(f.row.modelCapabilityProbes).toBeUndefined();
    expect(f.convergences()).toBe(0);
  });
  test("apply writes conclusive axes with provenance, leaves other axes, and converges", async () => {
    const f = probeFixture(body => isImage(body) ? status(400) : effortOf(body) === "high" ? status(400) : ok(), {
      modelCapabilities: { "test-model": { contextTier: "long_context", inputModalities: ["text", "image"] }, other: { inputModalities: ["text"] } },
      modelDefaultReasoningEfforts: { "test-model": "high" },
    });
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["low", "high"], confirmMetered: true, apply: true });
    expect(result).toMatchObject({ status: 200, body: { applied: { inputModalities: ["text"], reasoningEfforts: ["low"] } } });
    const row = f.config.providers.fixture!;
    expect(row.modelCapabilities).toEqual({ "test-model": { contextTier: "long_context", inputModalities: ["text"] }, other: { inputModalities: ["text"] } });
    expect(row.modelReasoningEfforts).toEqual({ "test-model": ["low"] });
    expect(row.modelDefaultReasoningEfforts).toBeUndefined();
    expect(row.modelCapabilityProbes).toEqual({ "test-model": { probedAt: expect.stringMatching(/Z$/), inputModalities: true, reasoningEfforts: true } });
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0]!.providers.fixture!.modelCapabilityProbes).toEqual(row.modelCapabilityProbes);
    expect(f.convergences()).toBe(1);
  });
  test("an inconclusive effort keeps the ladder untouched; a conclusive image still applies", async () => {
    const f = probeFixture(body => isImage(body) ? ok() : effortOf(body) === "high" ? status(500) : ok(),
      { modelReasoningEfforts: { "test-model": ["medium"] } });
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["low", "high"], confirmMetered: true, apply: true });
    expect(result.body.applied).toEqual({ inputModalities: ["text", "image"] });
    const row = f.config.providers.fixture!;
    expect(row.modelReasoningEfforts).toEqual({ "test-model": ["medium"] });
    expect(row.modelCapabilityProbes).toEqual({ "test-model": { probedAt: expect.any(String), inputModalities: true } });
  });
  test("an aliased model writes declarations and provenance under its native id", async () => {
    const f = probeFixture(body => isImage(body) ? ok() : effortOf(body) === "high" ? status(400) : ok(),
      { models: ["house-model"], modelAliases: { "house-model": "short" } });
    const result = await f.probe({ name: "fixture", model: "short", efforts: ["low", "high"], confirmMetered: true, apply: true });
    expect(result).toMatchObject({ status: 200, body: { model: "short", applied: { inputModalities: ["text", "image"], reasoningEfforts: ["low"] } } });
    expect(bodies(f.calls).every(body => body.model === "house-model")).toBe(true);
    const row = f.config.providers.fixture!;
    expect(row.modelCapabilities).toEqual({ "house-model": { inputModalities: ["text", "image"] } });
    expect(row.modelReasoningEfforts).toEqual({ "house-model": ["low"] });
    expect(Object.keys(row.modelCapabilityProbes!)).toEqual(["house-model"]);
  });
  test("a provider retargeted while the final response is pending receives none of the results", async () => {
    let f!: ReturnType<typeof probeFixture>;
    f = probeFixture(() => {
      f.config.providers.fixture = { ...f.config.providers.fixture!, baseUrl: "https://other.example/v1" };
      return ok();
    });
    const result = await f.probe({ name: "fixture", model: "test-model", checks: ["image"], confirmMetered: true, apply: true });
    expect(result.status).toBe(409);
    expect(result.body.applied).toBeUndefined();
    expect(f.saves).toHaveLength(0);
    expect(f.config.providers.fixture!.modelCapabilities).toBeUndefined();
    expect(f.config.providers.fixture!.modelCapabilityProbes).toBeUndefined();
  });
  test("a retarget between variants stops the rest and applies nothing", async () => {
    let f!: ReturnType<typeof probeFixture>;
    f = probeFixture(body => {
      if (isImage(body)) f.config.providers.fixture = { ...f.config.providers.fixture!, adapter: "openai-responses" };
      return ok();
    });
    const result = await f.probe({ name: "fixture", model: "test-model", efforts: ["low"], confirmMetered: true, apply: true });
    expect(result.status).toBe(409);
    expect(result.body.reasoning).toEqual({ accepted: [], rejected: [], inconclusive: ["low"] });
    expect(f.calls).toHaveLength(2);
    expect(f.saves).toHaveLength(0);
  });
  test("nothing conclusive: applied is empty and nothing is saved", async () => {
    const f = probeFixture(() => status(401));
    const result = await f.probe({ name: "fixture", model: "test-model", confirmMetered: true, apply: true });
    expect(result.body.baseline).toEqual({ status: "accepted" });
    expect(result.body.applied).toEqual({});
    expect(f.saves).toHaveLength(0);
    expect(f.row.modelCapabilityProbes).toBeUndefined();
  });
});
