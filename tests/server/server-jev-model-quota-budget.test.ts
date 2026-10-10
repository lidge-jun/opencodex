import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { buildJevState, JEV_MAX_REQUEST_BYTES, type JevCandidate } from "../../src/combos/jev";
import { buildJevModelPrompt, JEV_MODEL_INSTRUCTIONS, type JevModelInvoke } from "../../src/combos/jev-model-backend";
import { serializeJevModelRequest } from "../../src/combos/jev-model-request";
import { resolveJevComboDecision } from "../../src/combos/jev-dispatch";
import { jevQuotaCandidates } from "../../src/combos/jev-quota-route";
import { JEV_QUOTA_INSTRUCTION } from "../../src/combos/jev-quota";
import { createJevModelInvoker } from "../../src/server/responses/jev-model-invoke";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { invalidateDecisionKeyQuotas, publishDecisionKeyQuota } from "../../src/providers/quota-decision-snapshot";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

const now = 2_000_000_000_000;
const body = { input: 'Fixture "task" \\ with UTF-8 界' };
/** UTF-8 byte length of a string. */
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
let home: TempHome;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-jq-budget-");
  clock = spyOn(Date, "now").mockReturnValue(now);
  invalidateDecisionKeyQuotas();
  resetLifecycleDrainStateForTests();
});
afterEach(() => { invalidateDecisionKeyQuotas(); clock.mockRestore(); home.remove(); });
/** Minimal single-provider config for decision-model budget tests. */
function config(reasoning = false): OcxConfig {
  return { port: 0, defaultProvider: "p", providers: { p: {
    adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key", models: ["judge"],
    ...(reasoning ? { modelReasoningEfforts: { judge: ["low", "high"] } } : {}),
  } } };
}
/** Build the largest candidate set whose decision request still fits the byte limit. */
function nearLimitCandidates(): JevCandidate[] {
  for (let size = 100; size <= 500; size++) {
    const candidates = Array.from({ length: 42 }, (_, i) => ({ key: `p/${i}`, provider: "p", model: '界'.repeat(size) + i, reasoningEfforts: ["low"] as const }));
    const input = buildJevModelPrompt(buildJevState(body, candidates), candidates);
    const sizeBytes = bytes(serializeJevModelRequest({ model: "p/judge", instructions: JEV_MODEL_INSTRUCTIONS, input }));
    const rows = candidates.map(row => ({ ...row, quota: { tier: "nearly_exhausted" as const, usedPercent: 90, window: "weekly" as const } }));
    const quotaRequest = { model: "p/judge", instructions: JEV_MODEL_INSTRUCTIONS + " " + JEV_QUOTA_INSTRUCTION, input: buildJevModelPrompt(buildJevState(body, candidates), rows) };
    if (sizeBytes < JEV_MAX_REQUEST_BYTES && bytes(quotaRequest.instructions + quotaRequest.input) <= JEV_MAX_REQUEST_BYTES
      && bytes(serializeJevModelRequest(quotaRequest)) > JEV_MAX_REQUEST_BYTES) return candidates;
  }
  throw new Error("fixture must straddle the serialized quota boundary");
}
/** Common decision options for the budget tests. */
function options(cfg: OcxConfig, candidates: JevCandidate[], invokeModel: JevModelInvoke) {
  return { body, config: cfg, candidates, fallback: { targetKey: "p/0", effort: "low" as const }, decisionModel: "p/judge", invokeModel, now: () => now };
}

for (const reasoning of [false, true]) {
  test(`quota-only overflow strips before the actual detached invoker (reasoning ${reasoning})`, async () => {
    const cfg = config(reasoning);
    const candidates = nearLimitCandidates();
    const seen: string[] = [];
    const settled: unknown[] = [];
    const invoker = createJevModelInvoker({
      req: new Request("http://localhost/v1/responses", { headers: { authorization: "Bearer fixture-parent", "chatgpt-account-id": "fixture-parent" } }),
      config: cfg, options: {},
      handleResponses: async (request, _config, log, childOptions) => {
        seen.push(await request.text());
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("chatgpt-account-id")).toBeNull();
        expect(childOptions).toMatchObject({ callerDirectAuth: null, openAiSidecarAuth: null, nativeCallerAuth: null, internalDecisionCall: true });
        expect(childOptions!.turnAdmissionLease).toBeDefined();
        expect(childOptions!.sendBudget).toBeDefined();
        const settle = spyOn({ settle: (_usage?: unknown) => {} }, "settle").mockImplementation(usage => { settled.push(usage); });
        // The invoker only consumes settle from this synthetic detached tracker.
        log.spendTracker = { settle } as unknown as NonNullable<typeof log.spendTracker>;
        return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"choice":"p/0:low"}' }] }], usage: { input_tokens: 7, output_tokens: 2 } });
      },
    });
    const base = options(cfg, candidates, invoker);
    publishDecisionKeyQuota("p", cfg.providers.p!, [{ window: "weekly", percent: 90, observedAt: now }]);
    const quotaRows = jevQuotaCandidates({ ...base, decisionQuotaSignals: true });
    const quotaRequest = { model: "p/judge", instructions: JEV_MODEL_INSTRUCTIONS + " " + JEV_QUOTA_INSTRUCTION, input: buildJevModelPrompt(buildJevState(body, candidates), quotaRows) };
    expect(bytes(quotaRequest.instructions + quotaRequest.input)).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
    expect(bytes(serializeJevModelRequest(quotaRequest, reasoning ? "low" : undefined))).toBeGreaterThan(JEV_MAX_REQUEST_BYTES);
    expect((await resolveJevComboDecision(base)).gate).toBe("apply");
    // The ordinary route owner has now observed its key; publish against that live policy.
    publishDecisionKeyQuota("p", cfg.providers.p!, [{ window: "weekly", percent: 90, observedAt: now }]);
    const on = await resolveJevComboDecision({ ...base, decisionQuotaSignals: true });
    expect(on.gate).toBe("apply");
    expect(on.quota).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
    const input = buildJevModelPrompt(buildJevState(body, candidates), candidates);
    expect(seen[0]).toBe(JSON.stringify({ model: "p/judge", stream: true, store: false, instructions: JEV_MODEL_INSTRUCTIONS,
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }], tools: [], max_output_tokens: 1024,
      ...(reasoning ? { reasoning: { effort: "low" } } : {}),
    }));
    expect(bytes(seen[1]!)).toBeLessThanOrEqual(JEV_MAX_REQUEST_BYTES);
    expect(settled).toEqual([{ inputTokens: 7, outputTokens: 2 }, { inputTokens: 7, outputTokens: 2 }]);
    expect(on.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
  });
}

test("reasoning envelope itself participates in pre-invocation quota stripping", async () => {
  const cfg = config(true);
  const seen: string[] = [];
  const invoker = createJevModelInvoker({ req: new Request("http://localhost/v1/responses"), config: cfg, options: {}, handleResponses: async request => {
    seen.push(await request.text());
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"choice":"p/0:low"}' }] }] });
  } });
  publishDecisionKeyQuota("p", cfg.providers.p!, [{ window: "weekly", percent: 90, observedAt: now }]);
  const candidates = nearLimitCandidates();
  // Shrink one description so the quota request fits only when the reasoning field is omitted.
  let selected: JevCandidate[] | undefined;
  for (let cut = 1; cut < candidates[0]!.model.length; cut++) {
    const rows = candidates.map((row, i) => i ? row : { ...row, model: row.model.slice(cut) });
    const quota = jevQuotaCandidates({ ...options(cfg, rows, invoker), decisionQuotaSignals: true });
    const request = { model: "p/judge", instructions: JEV_MODEL_INSTRUCTIONS + " " + JEV_QUOTA_INSTRUCTION, input: buildJevModelPrompt(buildJevState(body, rows), quota) };
    if (bytes(serializeJevModelRequest(request)) <= JEV_MAX_REQUEST_BYTES && bytes(serializeJevModelRequest(request, "low")) > JEV_MAX_REQUEST_BYTES) { selected = rows; break; }
  }
  expect(selected).toBeDefined();
  const result = await resolveJevComboDecision({ ...options(cfg, selected!, invoker), decisionQuotaSignals: true });
  expect(result.gate).toBe("apply");
  expect(result.quota).toBeUndefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]).not.toContain("Quota nearly_exhausted");
  expect(JSON.parse(seen[0]!).reasoning).toEqual({ effort: "low" });
});

test("arbitrary malformed output is never retried without quota", async () => {
  const cfg = config();
  let calls = 0;
  const invoker = createJevModelInvoker({ req: new Request("http://localhost/v1/responses"), config: cfg, options: {}, handleResponses: async () => {
    calls++;
    return Response.json({ status: "incomplete", output: [] });
  } });
  const rows = [{ key: "p/0", provider: "p", model: "first", reasoningEfforts: ["low"] as const }];
  publishDecisionKeyQuota("p", cfg.providers.p!, [{ window: "weekly", percent: 90, observedAt: now }]);
  const result = await resolveJevComboDecision({ ...options(cfg, rows, invoker), decisionQuotaSignals: true });
  expect(result.gate).toBe("malformed");
  expect(calls).toBe(1);
});
