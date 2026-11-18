import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as sidecarAuth from "../../src/server/responses/request-sidecar-auth";
import type { RequestLogContext } from "../../src/server/request-log";
import { LUNA, SOL, perTurnConfig, resetState, turn } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

test.each([
  ["provider read 1", 1], ["provider read 2", 2], ["provider read 3", 3],
  ["images", 0], ["continuation", 0], ["churn", 0],
] as const)(
  "rechecks %s admission after the paid decision",
  async (change, providerRead) => {
    const payloads: Record<string, unknown>[] = [];
    const config = perTurnConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:low"], payloads);
    const combo = config.combos!.auto!;
    combo.capabilityPolicy = "union";
    const input = change === "images"
      ? [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }]
      : "hello ".repeat(4000);
    const request = { input, previousResponseId: change === "continuation" ? "resp_unavailable" : undefined };
    expect((await turn(config, request)).status).toBe(200);

    const fetchDecision = config.providers.jev!.fetch!;
    const provider = config.providers.sol!;
    function mutateOnRead(window: number, read = 1): void {
      Object.defineProperty(provider, "contextWindow", {
        configurable: true,
        enumerable: true,
        get() {
          Object.defineProperty(provider, "contextWindow", { value: window, writable: true });
          queueMicrotask(() => {
            if (change === "churn") mutateOnRead(window - 100, read + 1);
            else if (providerRead && read < providerRead) {
              config.combos!.auto = { ...combo, allowMeteredTargets: read % 2 === 1 };
              mutateOnRead(window - 100, read + 1);
            } else if (providerRead) provider.contextWindow = 1000;
            else config.combos!.auto = { ...combo, imageInput: "disabled" };
          });
          return window;
        },
      });
    }
    config.providers.jev!.fetch = (async (input, init) => {
      mutateOnRead(100_000);
      return fetchDecision(input, init);
    }) as typeof fetch;

    const models: string[] = [];
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await turn(config, { ...request, models, log });
    expect(payloads).toHaveLength(2);
    expect(log.jevDecision?.usage).toMatchObject({ totalTokens: 10 });
    expect(response.status).toBe(providerRead && providerRead < 3 ? 200 : change === "churn" || providerRead === 3 ? 503 : 400);
    expect(models).toEqual(providerRead && providerRead < 3 ? [`${LUNA.provider}/${LUNA.model}`] : []);
    if (change === "images" || change === "continuation") {
      const ingress = await turn(config, request);
      expect(response.status).toBe(ingress.status);
      expect(await response.json()).toEqual(await ingress.json());
      expect(payloads).toHaveLength(2);
    }
    if (change === "churn") expect(await response.text()).toContain("combo_unavailable");
  },
);

test("accounts for the completed decision when admission refresh is cancelled", async () => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.capabilityPolicy = "union";
  const controller = new AbortController();
  const decide = config.providers.jev!.fetch!;
  config.providers.jev!.fetch = (async (input, init) => {
    Object.defineProperty(config.providers.sol!, "contextWindow", {
      configurable: true,
      enumerable: true,
      get() {
        queueMicrotask(() => controller.abort());
        return 100_000;
      },
    });
    return decide(input, init);
  }) as typeof fetch;
  const models: string[] = [];
  const log: RequestLogContext = { model: "", provider: "" };
  expect((await turn(config, { models, log, signal: controller.signal })).status).toBe(499);
  expect(models).toEqual([]);
  expect(payloads).toHaveLength(1);
  expect(log.jevDecision?.usage).toMatchObject({ totalTokens: 10 });
});

test.each(["snapshot", "vision"] as const)("retains decision usage when %s readmission throws", async failure => {
  const payloads: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], payloads);
  config.combos!.auto!.capabilityPolicy = "union";
  const error = new Error("readmission failed");
  for (const provider of [config.providers.sol!, config.providers.luna!]) provider.inputModalities = ["text"];
  const decide = config.providers.jev!.fetch!;
  config.providers.jev!.fetch = (async (input, init) => {
    if (failure === "snapshot") {
      config.providers.sol!.modelContextWindows = new Proxy({}, { ownKeys() { throw error; } });
    }
    return decide(input, init);
  }) as typeof fetch;
  const probe = spyOn(sidecarAuth, "canDescribeComboImages").mockImplementation(async () => {
    if (failure === "vision" && payloads.length) throw error;
    return false;
  });
  const log: RequestLogContext = { model: "", provider: "" };
  const models: string[] = [];
  try {
    await expect(turn(config, { log, models, ...(failure === "vision" ? {
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }],
    } : {}) })).rejects.toThrow();
    expect(payloads).toHaveLength(1);
    expect(models).toEqual([]);
    expect(log.jevDecision?.usage).toMatchObject({ inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  } finally {
    probe.mockRestore();
  }
});
