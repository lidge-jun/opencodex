import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";

const entry = PROVIDER_REGISTRY.find(provider => provider.id === "mimo-free")!;

describe("MiMo Free reasoning effort (#1483)", () => {
  test("catalog exposes only endpoint-supported effort tiers", () => {
    expect(entry.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  test("effort map clamps unsupported tiers to high", () => {
    expect(entry.reasoningEffortMap).toEqual({ xhigh: "high", max: "high", ultra: "high" });
  });

  test("xiaomi-mimo paid entry has the same effort contract", () => {
    const paid = PROVIDER_REGISTRY.find(p => p.id === "xiaomi-mimo")!;
    expect(paid.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(paid.reasoningEffortMap).toEqual({ xhigh: "high", max: "high", ultra: "high" });
  });
});
