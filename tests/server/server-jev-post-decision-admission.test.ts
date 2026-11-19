import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as openAiSidecar from "../../src/providers/openai-sidecar";
import type { ResolvedOpenAiForwardSidecar } from "../../src/providers/openai-sidecar";
import * as sidecarAuth from "../../src/server/responses/request-sidecar-auth";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";
import { planVisionSidecar } from "../../src/vision";
import {
  duringDecision, IMAGE_INPUT, LUNA, SOL, resetState, served, turn, unionConfig, type Child, type ChildOptions,
} from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

const SOL_ROUTE = SOL.provider + "/" + SOL.model;
const FORWARD_SIDECAR = { headers: new Headers() } as unknown as ResolvedOpenAiForwardSidecar;
const IMAGE_PARSED = {
  context: { messages: [{ role: "user", content: [{ type: "image", url: "https://example.test/image.png" }] }] },
} as unknown as OcxParsedRequest;

/** The vision backend the child's own planner selects from the config and options it was handed. */
function childVisionBackend(config: OcxConfig, options: ChildOptions): string {
  const visionConfig = sidecarAuth.responsesVisionConfig({ config, options: options ?? {} });
  return planVisionSidecar(visionConfig, config.providers.sol!, SOL.model, IMAGE_PARSED, FORWARD_SIDECAR,
    { providerName: SOL.provider })?.backend ?? "none";
}

// Admission is evaluated once against the request-start snapshot. An edit made while the paid
// decision is in flight must not change how that request is served; the next request sees it.
test.each(["capabilities", "vision sidecar"] as const)("%s changed during the paid decision apply to the next request", async change => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:high"], payloads);
  config.providers.luna!.inputModalities = ["text"];
  config.providers.sol!.inputModalities = change === "capabilities" ? ["text", "image"] : ["text"];
  config.visionSidecar = { backend: "openai" };
  spyOn(sidecarAuth, "canDescribeComboImages").mockImplementation(async () => true);
  duringDecision(config, () => {
    if (change === "capabilities") config.providers.sol!.inputModalities = ["text"];
    else config.visionSidecar = { backend: "openai", enabled: false };
  });
  const served_: string[][] = [];
  const child: Child = (body, complete, options, childConfig) => {
    served_.push([
      String(body.model),
      options?.comboOmitImages ? "omit" : options?.comboRequiresVisionPlan ? "describe" : "native",
      childVisionBackend(childConfig, options),
    ]);
    return served(body, complete, options);
  };
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect(payloads).toHaveLength(2);
  // The admitted describe child plans with the request-start sidecar; the next request sees the edit.
  expect(served_).toEqual(change === "capabilities"
    ? [[SOL_ROUTE, "native", "openai"], [SOL_ROUTE, "describe", "openai"]]
    : [[SOL_ROUTE, "describe", "openai"], [SOL_ROUTE, "omit", "none"]]);
});

test("a vision sidecar edit while a describe probe waits for its credential applies to the next request", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.onUnservable = "reject";
  for (const provider of [config.providers.sol!, config.providers.luna!]) provider.inputModalities = ["text"];
  config.visionSidecar = { enabled: true, backend: "openai" };
  let probes = 0;
  spyOn(openAiSidecar, "resolveFirstUsableOpenAiSidecar").mockImplementation(async () => {
    probes++;
    // The first member's probe is still waiting when the operator disables the sidecar.
    if (probes === 1) config.visionSidecar = { enabled: false };
    await Promise.resolve();
    return FORWARD_SIDECAR;
  });
  const served_: string[][] = [];
  const child: Child = (body, complete, options, childConfig) => {
    served_.push([
      String(body.model), options?.comboRequiresVisionPlan ? "describe" : "other", childVisionBackend(childConfig, options),
    ]);
    return served(body, complete, options);
  };
  // The in-flight request keeps its request-start plan for every member, including the child's.
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect(probes).toBe(2);
  expect(served_).toEqual([[SOL_ROUTE, "describe", "openai"]]);
  expect(payloads).toHaveLength(1);
  // The next request is admitted with the sidecar disabled: no probe, no decision, reject.
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(400);
  expect(probes).toBe(2);
  expect(served_).toHaveLength(1);
  expect(payloads).toHaveLength(1);
});

test("a request cancelled during the post-decision recheck keeps its usage and sends nothing", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.targets = config.combos!.auto!.targets.map(target => ({ ...target, metered: true }));
  config.combos!.auto!.allowMeteredTargets = true;
  const controller = new AbortController();
  // The client disconnects while live consent is reread, after the decision has been paid for.
  duringDecision(config, () => {
    const combos = config.combos;
    Object.defineProperty(config, "combos", { configurable: true, enumerable: true, get() { controller.abort(); return combos; } });
  }, true);
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  expect((await turn(config, { models, log, signal: controller.signal })).status).toBe(499);
  expect(models).toEqual([]);
  expect(payloads).toHaveLength(1);
  expect(log.jevDecision?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
});

test("an exception in the post-decision spend recheck keeps the decision usage", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.apiKeys = [{ id: "caller", name: "caller", key: "fixture", createdAt: "2026-01-01T00:00:00.000Z" }];
  const error = new Error("synthetic recheck failure");
  duringDecision(config, () => {
    Object.defineProperty(config, "apiKeys", { configurable: true, enumerable: true, get() { throw error; } });
  }, true);
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  const response = await turn(config, {
    models, log, admission: { kind: "configured", source: "bearer", keyId: "caller", contextPrincipalId: "caller" },
  });
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).toContain("combo_unavailable");
  expect(text).not.toContain(error.message);
  expect(payloads).toHaveLength(1);
  expect(models).toEqual([]);
  expect(log.jevDecision?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
});

test("reads every member's capability metadata before awaiting image planning", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high"], payloads);
  for (const provider of [config.providers.sol!, config.providers.luna!]) provider.inputModalities = ["text"];
  const probes: string[] = [];
  spyOn(sidecarAuth, "canDescribeComboImages").mockImplementation(async (_context, route) => {
    probes.push(route.providerName);
    // Too late for this request: the gate already judged both members from its snapshot.
    if (route.providerName === LUNA.provider) config.providers.sol!.inputModalities = ["text", "image"];
    return false;
  });
  const models: string[] = [];
  expect((await turn(config, { input: IMAGE_INPUT, models })).status).toBe(200);
  expect(probes).toEqual([LUNA.provider, SOL.provider]);
  expect(models).toEqual([SOL_ROUTE]);
});
