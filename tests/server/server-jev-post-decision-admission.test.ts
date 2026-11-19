import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as sidecarAuth from "../../src/server/responses/request-sidecar-auth";
import type { RequestLogContext } from "../../src/server/request-log";
import { duringDecision, IMAGE_INPUT, LUNA, SOL, resetState, served, turn, unionConfig, type Child } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

const SOL_ROUTE = SOL.provider + "/" + SOL.model;

// Admission is evaluated once against the request-start snapshot. An edit made while the paid
// decision is in flight must not change how that request is served; the next request sees it.
test.each(["capabilities", "vision sidecar"] as const)("%s changed during the paid decision apply to the next request", async change => {
  const payloads: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:high"], payloads);
  config.providers.luna!.inputModalities = ["text"];
  config.providers.sol!.inputModalities = change === "capabilities" ? ["text", "image"] : ["text"];
  spyOn(sidecarAuth, "canDescribeComboImages").mockImplementation(async () => true);
  duringDecision(config, () => {
    if (change === "capabilities") config.providers.sol!.inputModalities = ["text"];
    else config.visionSidecar = { enabled: false };
  });
  const served_: string[][] = [];
  const child: Child = (body, complete, options) => {
    served_.push([String(body.model), options?.comboOmitImages ? "omit" : options?.comboRequiresVisionPlan ? "describe" : "native"]);
    return served(body, complete, options);
  };
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect((await turn(config, { input: IMAGE_INPUT, child })).status).toBe(200);
  expect(payloads).toHaveLength(2);
  expect(served_).toEqual(change === "capabilities"
    ? [[SOL_ROUTE, "native"], [SOL_ROUTE, "describe"]]
    : [[SOL_ROUTE, "describe"], [SOL_ROUTE, "omit"]]);
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
