import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxProviderConfig } from "../../src/types";

/**
 * Data-driven reasoning ladders (models.dev snapshot + learned refusals).
 *
 * OpenCode Zen Go publishes model ids only, so the catalog used to advertise whatever the
 * registry hardcoded -- including rungs the upstream refuses (muse-spark max -> 400 "requires an
 * active Muse Code subscription"). These cases pin the metadata fallback, the wire clamp and the
 * learned-refusal filter that keeps a rejected rung out of every later request.
 */

const ZEN_GO: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://opencode.ai/zen/go/v1",
} as OcxProviderConfig;

const MUSE_SPARK = "muse-spark-1.3-contributor";
const DEEPSEEK_FLASH = "deepseek-v4.1-flash";

const REJECTION_BODY = JSON.stringify({
  model: MUSE_SPARK,
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});

const roots: string[] = [];

function snapshotFile(providers: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, fetchedAt: Date.now(), source: "test", providers };
}

function sandbox(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-reasoning-metadata-"));
  roots.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  process.env["OPENCODEX_HOME"] = dir;
  return dir;
}

async function load(files: Record<string, string> = {}) {
  sandbox(files);
  const metadata = await import("../../src/providers/reasoning-metadata");
  const effort = await import("../../src/reasoning-effort");
  metadata.resetReasoningMetadataCachesForTests();
  return { metadata, effort };
}

function metadataFile(providers: Record<string, unknown>): Record<string, string> {
  return { "reasoning-metadata-cache.json": JSON.stringify(snapshotFile(providers)) };
}

function metadataFileV2(providers: Record<string, unknown>, apis: Record<string, string>): Record<string, string> {
  return {
    "reasoning-metadata-cache.json": JSON.stringify({ ...snapshotFile(providers), version: 2, apis }),
  };
}

function supportFile(rows: Record<string, unknown>): Record<string, string> {
  return { "reasoning-support-cache.json": JSON.stringify({ version: 1, rows }) };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["OPENCODEX_HOME"];
});

describe("models.dev reasoning metadata", () => {
  test("advertises the published effort rungs and strips the none/minimal sentinels", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": {
        [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }] },
      },
    }));
    expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("clamps a rung the model does not publish instead of failing upstream", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": {
        [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }] },
        [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] },
      },
    }));
    expect(effort.mapReasoningEffort(ZEN_GO, MUSE_SPARK, "max")).toBe("xhigh");
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe("max");
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "ultra")).toBe("max");
  });

  test("a hand-written ladder stays authoritative and unknown models stay untouched", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "medium", "high", "xhigh"] }] } },
    }));
    const pinned = { ...ZEN_GO, modelReasoningEfforts: { [MUSE_SPARK]: ["low", "high"] } } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(pinned, MUSE_SPARK)).toEqual(["low", "high"]);
    expect(effort.configuredReasoningEfforts(ZEN_GO, "not-a-model")).toBeUndefined();
  });

  test("a destination the snapshot does not describe keeps the previous behaviour", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "high"] }] } },
    }));
    const elsewhere = { ...ZEN_GO, baseUrl: "https://api.deepseek.com/v1" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(elsewhere, MUSE_SPARK)).toBeUndefined();
  });

  test("a toggle-only entry never invents wire semantics for an unclassified model", async () => {
    const { effort } = await load(metadataFile({
      "opencode-go": { "minimax-m3": { reasoning: true, options: [{ type: "toggle" }] } },
    }));
    expect(effort.configuredReasoningEfforts(ZEN_GO, "minimax-m3")).toBeUndefined();
  });

  test("a corrupt or missing snapshot falls back to the status quo", async () => {
    const { effort } = await load({ "reasoning-metadata-cache.json": "{not json" });
    expect(effort.configuredReasoningEfforts(ZEN_GO, MUSE_SPARK)).toBeUndefined();
    expect(effort.mapReasoningEffort(ZEN_GO, MUSE_SPARK, "max")).toBe("max");
  });
});

describe("learned rung refusals", () => {
  const refused = () => ({
    ["opencode-go|" + DEEPSEEK_FLASH + "|max"]: { effort: "max", at: Date.now() },
  });

  test("drops a refused rung from a metadata-derived ladder", async () => {
    const { effort } = await load({
      ...metadataFile({ "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } } }),
      ...supportFile(refused()),
    });
    expect(effort.configuredReasoningEfforts(ZEN_GO, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
    expect(effort.mapReasoningEffort(ZEN_GO, DEEPSEEK_FLASH, "max")).toBe("high");
  });

  test("drops a refused rung from a ladder pinned in the registry too", async () => {
    const { effort } = await load(supportFile(refused()));
    const pinned = { ...ZEN_GO, modelReasoningEfforts: { [DEEPSEEK_FLASH]: ["low", "high", "max"] } } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(pinned, DEEPSEEK_FLASH)).toEqual(["low", "high"]);
  });

  test("records the refusal and plans the next lower published rung once", async () => {
    const { metadata } = await load({
      ...metadataFile({ "opencode-go": { [DEEPSEEK_FLASH]: { reasoning: true, options: [{ type: "effort", values: ["low", "high", "max"] }] } } }),
    });
    const first = metadata.planReasoningEffortDowngrade({
      provider: ZEN_GO, modelId: DEEPSEEK_FLASH, requested: "max", rejectionText: REJECTION_BODY,
    });
    expect(first).toEqual({ effort: "high", recorded: true });
    metadata.flushReasoningSupportCache();
    const second = metadata.planReasoningEffortDowngrade({
      provider: ZEN_GO, modelId: DEEPSEEK_FLASH, requested: "max", rejectionText: REJECTION_BODY,
    });
    expect(second).toEqual({ effort: "high", recorded: false });
  });

  test("classifies only reasoning-effort refusals", async () => {
    const { metadata } = await load();
    expect(metadata.isReasoningEffortRejection(REJECTION_BODY)).toBe(true);
    expect(metadata.isReasoningEffortRejection(JSON.stringify({ error: { message: "Invalid upload request." } }))).toBe(false);
    expect(metadata.isReasoningEffortRejection(undefined)).toBe(false);
  });
});

describe("destination resolution", () => {
  const ZEN = { ...ZEN_GO, baseUrl: "https://opencode.ai/zen/v1" } as OcxProviderConfig;
  const MODEL = { [MUSE_SPARK]: { reasoning: true, options: [{ type: "effort", values: ["low", "high"] }] } };

  test("resolves the OpenCode family and tolerates a trailing slash", async () => {
    const { effort } = await load(metadataFile({ "opencode": MODEL, "opencode-go": MODEL }));
    expect(effort.configuredReasoningEfforts(ZEN, MUSE_SPARK)).toEqual(["low", "high"]);
    const trailingSlash = { ...ZEN_GO, baseUrl: "https://opencode.ai/zen/go/v1/" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(trailingSlash, MUSE_SPARK)).toEqual(["low", "high"]);
  });

  // 36 of the registry's 83 destinations match a models.dev provider, so resolving by URL alone
  // would move ladders for providers this change has no evidence for. The gate stays explicit.
  test("a destination that only matches by URL stays gated out", async () => {
    const { effort } = await load(metadataFileV2(
      { "some-upstream": MODEL },
      { "some-upstream": "https://api.some-upstream.example/v1" },
    ));
    const provider = { ...ZEN_GO, baseUrl: "https://api.some-upstream.example/v1" } as OcxProviderConfig;
    expect(effort.configuredReasoningEfforts(provider, MUSE_SPARK)).toBeUndefined();
  });

  test("the v2 snapshot confirms the gate against each provider's published api url", async () => {
    const { metadata } = await load(metadataFileV2(
      { "opencode-go": MODEL },
      { "opencode-go": "https://opencode.ai/zen/go" },
    ));
    expect(metadata.reasoningMetadataMapping()).toEqual([
      { destination: "https://opencode.ai/zen/go/v1", provider: "opencode-go", publishedApi: "https://opencode.ai/zen/go", confirmed: true, models: 1 },
      { destination: "https://opencode.ai/zen/v1", provider: "opencode", models: 0 },
    ]);
  });

  test("a v1 snapshot without published api urls still resolves through the table", async () => {
    const { metadata } = await load(metadataFile({ "opencode-go": MODEL }));
    const [zenGo] = metadata.reasoningMetadataMapping();
    expect(zenGo.publishedApi).toBeUndefined();
    expect(zenGo.confirmed).toBeUndefined();
    expect(zenGo.models).toBe(1);
  });
});
