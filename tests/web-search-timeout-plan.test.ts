import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import {
  planWebSearch,
  resolveRoutedModelStallTimeoutMs,
  webSearchStallTimeoutSec,
} from "../src/web-search";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  apiKey: "routed-key",
};

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test/v1",
  authMode: "forward",
};

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: { routed: routedProvider, chatgpt: forwardProvider },
    ...overrides,
  };
}

function plan(input: OcxConfig) {
  const parsed = parseRequest({
    model: "routed/model",
    input: "Search current docs",
    stream: true,
    tools: [{ type: "web_search" }],
  });
  return planWebSearch(
    input,
    parsed,
    false,
    new Headers({ authorization: "Bearer chatgpt" }),
    routedProvider,
    "model",
  );
}

describe("routed-model web-search inactivity timeout", () => {
  test("resolver accepts only integer millisecond values in the supported range", () => {
    expect(resolveRoutedModelStallTimeoutMs(1)).toBe(1);
    expect(resolveRoutedModelStallTimeoutMs(2_147_483_647)).toBe(2_147_483_647);

    for (const malformed of [
      undefined,
      null,
      "240000",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      1.5,
      2_147_483_648,
    ]) {
      expect(resolveRoutedModelStallTimeoutMs(malformed)).toBe(200_000);
    }
  });

  test("plan resolves default, explicit, and malformed values without materializing a missing field", () => {
    const defaults = config({ webSearchSidecar: {} });
    expect(plan(defaults)?.routedModelStallTimeoutMs).toBe(200_000);
    expect(defaults.webSearchSidecar).not.toHaveProperty("routedModelStallTimeoutMs");

    expect(plan(config({
      webSearchSidecar: { routedModelStallTimeoutMs: 240_000 },
    }))?.routedModelStallTimeoutMs).toBe(240_000);

    const malformed = config({
      webSearchSidecar: { routedModelStallTimeoutMs: "bad" as unknown as number },
    });
    expect(plan(malformed)?.routedModelStallTimeoutMs).toBe(200_000);
    expect(malformed.webSearchSidecar?.routedModelStallTimeoutMs).toBe("bad");
  });

  test("bridge budget covers every timeout plus a thirty-second margin", () => {
    expect(webSearchStallTimeoutSec(undefined, 200_000, 200_000, 200_000)).toBe(230);
    expect(webSearchStallTimeoutSec(undefined, 200_000, 240_000, 200_000)).toBe(270);
    expect(webSearchStallTimeoutSec(600, 200_000, 240_000, 200_000)).toBe(630);

    const maximum = webSearchStallTimeoutSec(undefined, 200_000, 2_147_483_647, 200_000);
    expect(maximum).toBe(2_147_514);
    expect(Number.isFinite(maximum)).toBe(true);
    expect(Number.isInteger(maximum)).toBe(true);
  });

  test("plan returns both resolved budgets", () => {
    expect(plan(config({
      webSearchSidecar: { routedModelStallTimeoutMs: 240_000 },
    }))).toMatchObject({
      routedModelStallTimeoutMs: 240_000,
      stallTimeoutSec: 270,
    });
  });
});
