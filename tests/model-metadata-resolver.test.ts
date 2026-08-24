import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCatalogModelMetadata } from "../src/codex/catalog/effort";
import {
  MODEL_METADATA_CACHE_FILENAME,
  applyResolvedMetadataToCatalogModel,
  enrichCatalogModelMetadata,
  persistLiveModelMetadata,
  readSnapshotLayer,
  resetModelMetadataCacheForTests,
  resolveModelMetadata,
  snapshotKey,
} from "../src/codex/catalog/model-metadata";
import { ensureStrictCatalogFields } from "../src/codex/catalog/parsing";
import type { CatalogModel, RawEntry } from "../src/codex/catalog/parsing";
import { buildCatalogEntries } from "../src/codex/catalog/sync";

let previousHome: string | undefined;
let testHome = "";

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testHome = mkdtempSync(join(tmpdir(), "ocx-model-metadata-"));
  process.env.OPENCODEX_HOME = testHome;
  resetModelMetadataCacheForTests();
});

afterEach(() => {
  resetModelMetadataCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

describe("resolveModelMetadata precedence", () => {
  test("fresh live discovery wins over registry and snapshot", () => {
    const resolved = resolveModelMetadata({
      live: { contextWindow: 500_000, maxInputTokens: 450_000, observedAt: "2026-08-24T10:00:00.000Z" },
      liveFresh: true,
      registry: { contextWindow: 200_000, maxOutputTokens: 8_192, inputModalities: ["text"] },
      snapshot: { contextWindow: 128_000, observedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(resolved.contextWindow).toBe(500_000);
    expect(resolved.maxInputTokens).toBe(450_000);
    expect(resolved.maxOutputTokens).toBe(8_192);
    expect(resolved.inputModalities).toEqual(["text"]);
    expect(resolved.source).toBe("live");
    expect(resolved.fieldSources.contextWindow).toBe("live");
    expect(resolved.fieldSources.inputModalities).toBe("registry");
    expect(resolved.stale).toBe(false);
    expect(resolved.observedAt).toBe("2026-08-24T10:00:00.000Z");
  });

  test("an explicit cap never raises a known window and does not become the source", () => {
    const resolved = resolveModelMetadata({
      live: { contextWindow: 200_000, observedAt: "2026-08-24T10:00:00.000Z" },
      liveFresh: true,
      caps: { providerCap: 350_000 },
    });
    expect(resolved.contextWindow).toBe(200_000);
    expect(resolved.detectedContextWindow).toBe(200_000);
    expect(resolved.contextCapped).toBe(false);
    expect(resolved.source).toBe("live");
  });

  test("an explicit cap lowers a larger discovered window", () => {
    const resolved = resolveModelMetadata({
      live: { contextWindow: 1_050_000, observedAt: "2026-08-24T10:00:00.000Z" },
      liveFresh: true,
      caps: { providerCap: 350_000 },
    });
    expect(resolved.contextWindow).toBe(350_000);
    expect(resolved.detectedContextWindow).toBe(1_050_000);
    expect(resolved.contextCapped).toBe(true);
    expect(resolved.source).toBe("live");
    expect(resolved.fieldSources.contextWindow).toBe("live");
  });

  test("registry fills when live is missing", () => {
    const resolved = resolveModelMetadata({
      registry: { contextWindow: 1_000_000, maxOutputTokens: 64_000, inputModalities: ["text", "image"] },
      snapshot: { contextWindow: 128_000 },
    });
    expect(resolved.contextWindow).toBe(1_000_000);
    expect(resolved.maxOutputTokens).toBe(64_000);
    expect(resolved.source).toBe("registry");
    expect(resolved.stale).toBe(false);
  });

  test("stale snapshot is used only after live and registry are absent", () => {
    const resolved = resolveModelMetadata({
      live: { contextWindow: 999_999, observedAt: "2026-08-01T00:00:00.000Z" },
      liveFresh: false,
      snapshot: { contextWindow: 500_000, observedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(resolved.contextWindow).toBe(500_000);
    expect(resolved.source).toBe("snapshot");
    expect(resolved.stale).toBe(true);
    expect(resolved.observedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  test("configured fallback is used only when nothing was discovered", () => {
    const resolved = resolveModelMetadata({ caps: { providerWindow: 350_000 } });
    expect(resolved.contextWindow).toBe(350_000);
    expect(resolved.source).toBe("config_fallback");
    expect(resolved.detectedContextWindow).toBeUndefined();
    expect(resolved.contextCapped).toBe(false);
  });

  test("unknown stays empty and does not invent 128k", () => {
    const resolved = resolveModelMetadata({});
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.source).toBe("unknown");
    expect(resolved.stale).toBe(false);
  });

  test("registry maxTokens maps to maxOutputTokens, never to context", () => {
    const resolved = resolveModelMetadata({
      registry: { maxOutputTokens: 8_192 },
    });
    expect(resolved.contextWindow).toBeUndefined();
    expect(resolved.maxOutputTokens).toBe(8_192);
    expect(resolved.source).toBe("registry");
  });

  test("fresh live fetch with no context falls back to snapshot before registry", () => {
    const resolved = resolveModelMetadata({
      live: { observedAt: "2026-08-24T12:00:00.000Z" },
      liveFresh: true,
      registry: { contextWindow: 200_000 },
      snapshot: { contextWindow: 262_144, observedAt: "2026-08-20T10:00:00.000Z" },
    });
    expect(resolved.contextWindow).toBe(262_144);
    expect(resolved.source).toBe("snapshot");
    expect(resolved.stale).toBe(true);
    expect(resolved.fieldSources.contextWindow).toBe("snapshot");
  });

  test("enrich uses snapshot for ID-only live rows when disk has last-known-good context", () => {
    persistLiveModelMetadata("together", [{
      id: "acme/chat-pro",
      contextWindow: 262_144,
      observedAt: "2026-08-20T10:00:00.000Z",
    }]);
    const enriched = enrichCatalogModelMetadata(
      { provider: "together", id: "acme/chat-pro" },
      { liveFresh: true },
    );
    expect(enriched.contextWindow).toBe(262_144);
    expect(enriched.metadataSource).toBe("snapshot");
    expect(enriched.metadataStale).toBe(true);
  });

  test("enrich fills an ID-only live row from the registry when no snapshot exists", () => {
    const enriched = enrichCatalogModelMetadata(
      { provider: "opencode-go", id: "grok-4.6" },
      { liveFresh: true },
    );
    expect(enriched.contextWindow).toBe(500_000);
    expect(enriched.metadataSource).toBe("registry");
    expect(enriched.maxOutputTokens).toBe(500_000);
  });

  test("applyResolvedMetadataToCatalogModel preserves management API metadata fields", () => {
    const resolved = resolveModelMetadata({
      live: { contextWindow: 1_050_000, observedAt: "2026-08-24T10:00:00.000Z" },
      liveFresh: true,
      caps: { providerCap: 350_000 },
    });
    const model = applyResolvedMetadataToCatalogModel({ provider: "together", id: "acme/chat-pro" }, resolved);
    const row = { ...model, namespaced: "together/acme/chat-pro", disabled: false };
    expect(row.metadataSource).toBe("live");
    expect(row.detectedContextWindow).toBe(1_050_000);
    expect(row.metadataStale).toBe(false);
    expect(row.contextCapped).toBe(true);
  });

  test("enrich leaves derived combo rows untouched", () => {
    const combo: CatalogModel = {
      provider: "combo",
      id: "pair",
      contextWindow: 200_000,
      metadataSource: "derived",
    };
    expect(enrichCatalogModelMetadata(combo, { liveFresh: false })).toEqual(combo);
  });
});

describe("capability provenance skips compatibility 128k", () => {
  test("an unknown model does not stamp 128000 into provenance", () => {
    const model: CatalogModel = { provider: "demo", id: "unknown-model", metadataSource: "unknown" };
    const entry: RawEntry = { slug: "demo/unknown-model" };
    applyCatalogModelMetadata(entry, model);
    const strict = ensureStrictCatalogFields({ ...entry }, { isRouted: true });
    expect(strict.context_window).toBe(128_000);
    expect(entry.opencodex_capability_provenance).toBeUndefined();
  });

  test("a live window stamps source, observed_at, and max_input_tokens", () => {
    const model: CatalogModel = {
      provider: "together",
      id: "acme/chat-pro",
      contextWindow: 262_144,
      maxInputTokens: 250_000,
      metadataSource: "live",
      metadataObservedAt: "2026-08-24T10:00:00.000Z",
    };
    const entry: RawEntry = { slug: "together/acme-chat-pro" };
    applyCatalogModelMetadata(entry, model);
    const provenance = entry.opencodex_capability_provenance as Record<string, unknown>;
    expect(entry.context_window).toBe(262_144);
    expect(entry.max_context_window).toBe(262_144);
    expect(entry.auto_compact_token_limit).toBe(Math.min(Math.floor(262_144 * 0.9), 250_000));
    expect(provenance.context_window).toBe(262_144);
    expect(provenance.max_input_tokens).toBe(250_000);
    expect(provenance.source).toBe("live");
    expect(provenance.observed_at).toBe("2026-08-24T10:00:00.000Z");
  });

  test("deriveEntry writes resolved CatalogModel fields into both Codex window slots", () => {
    const entries = buildCatalogEntries({ context_window: 372_000 }, [], [{
      provider: "together",
      id: "acme/chat-pro",
      contextWindow: 350_000,
      detectedContextWindow: 1_050_000,
      contextCap: 350_000,
      contextCapped: true,
      maxInputTokens: 350_000,
      metadataSource: "live",
      metadataObservedAt: "2026-08-24T10:00:00.000Z",
    }]);
    const routed = entries.find(entry => entry.slug === "together/acme-chat-pro");
    expect(routed?.context_window).toBe(350_000);
    expect(routed?.max_context_window).toBe(350_000);
    expect(routed?.auto_compact_token_limit).toBe(Math.floor(350_000 * 0.9));
    const provenance = routed?.opencodex_capability_provenance as Record<string, unknown>;
    expect(provenance.source).toBe("live");
    expect(provenance.observed_at).toBe("2026-08-24T10:00:00.000Z");
    expect(provenance.max_input_tokens).toBe(350_000);
  });

  test("a cap-lowered live window writes the capped catalog values", () => {
    const model: CatalogModel = {
      provider: "together",
      id: "acme/chat-pro",
      contextWindow: 350_000,
      detectedContextWindow: 1_050_000,
      contextCap: 350_000,
      contextCapped: true,
      maxInputTokens: 350_000,
      metadataSource: "live",
    };
    const entry: RawEntry = { slug: "together/acme-chat-pro" };
    applyCatalogModelMetadata(entry, model);
    expect(entry.context_window).toBe(350_000);
    expect(entry.max_context_window).toBe(350_000);
    expect(entry.auto_compact_token_limit).toBe(Math.floor(350_000 * 0.9));
    const provenance = entry.opencodex_capability_provenance as Record<string, unknown>;
    expect(provenance.context_window).toBe(350_000);
    expect(provenance.source).toBe("live");
  });
});

describe("model-metadata disk snapshot", () => {
  test("persists sanitized last-known-good rows under getConfigDir()", () => {
    persistLiveModelMetadata("together", [{
      id: "acme/chat-pro",
      contextWindow: 262_144,
      maxInputTokens: 250_000,
      inputModalities: ["text", "image"],
      observedAt: "2026-08-24T10:00:00.000Z",
    }]);
    const path = join(testHome, MODEL_METADATA_CACHE_FILENAME);
    expect(existsSync(path)).toBe(true);
    const body = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      models: Record<string, Record<string, unknown>>;
    };
    expect(body.version).toBe(1);
    const row = body.models[snapshotKey("together", "acme/chat-pro")];
    expect(row.contextWindow).toBe(262_144);
    expect(row.maxInputTokens).toBe(250_000);
    expect(JSON.stringify(body)).not.toContain("sk-");
    expect(JSON.stringify(body)).not.toContain("Bearer");
    expect(JSON.stringify(body)).not.toContain("apiKey");
  });

  test("drops secrets, control characters, and unsafe integers", () => {
    persistLiveModelMetadata("evil", [{
      id: "ok-model",
      contextWindow: 32_000,
      apiKey: "sk-secret",
      authorization: "Bearer leaked",
    } as never, {
      id: "bad\u0000id",
      contextWindow: 99_000,
    }, {
      id: "unsafe",
      contextWindow: Number.MAX_SAFE_INTEGER + 1,
    }]);
    const body = JSON.parse(readFileSync(join(testHome, MODEL_METADATA_CACHE_FILENAME), "utf8")) as {
      models: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(body.models)).toEqual([snapshotKey("evil", "ok-model")]);
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("Bearer leaked");
    expect(body.models[snapshotKey("evil", "ok-model")].contextWindow).toBe(32_000);
  });

  test("reads the snapshot layer back after a reset", () => {
    persistLiveModelMetadata("together", [{
      id: "acme/chat-pro",
      contextWindow: 262_144,
      observedAt: "2026-08-24T10:00:00.000Z",
    }]);
    resetModelMetadataCacheForTests({ hydrateFromDisk: true });
    expect(readSnapshotLayer("together", "acme/chat-pro")).toEqual({
      contextWindow: 262_144,
      observedAt: "2026-08-24T10:00:00.000Z",
    });
  });

  test("skips the write when the captured config generation is stale", () => {
    persistLiveModelMetadata("together", [{
      id: "fresh",
      contextWindow: 111_000,
    }], { writerGeneration: 0 });
    persistLiveModelMetadata("together", [{
      id: "stale-writer",
      contextWindow: 222_000,
    }], { writerGeneration: -1 });
    const body = JSON.parse(readFileSync(join(testHome, MODEL_METADATA_CACHE_FILENAME), "utf8")) as {
      models: Record<string, { contextWindow?: number }>;
    };
    expect(body.models[snapshotKey("together", "fresh")]?.contextWindow).toBe(111_000);
    expect(body.models[snapshotKey("together", "stale-writer")]).toBeUndefined();
  });

  test("stale model-cache generation does not clobber an existing snapshot", async () => {
    const { captureModelCacheGeneration, clearModelCache } = await import("../src/codex/model-cache");
    const generation = captureModelCacheGeneration("together");
    persistLiveModelMetadata("together", [{
      id: "acme/chat-pro",
      contextWindow: 262_144,
    }], { writerGeneration: generation });
    clearModelCache("together");
    persistLiveModelMetadata("together", [{
      id: "acme/chat-pro",
      contextWindow: 999_000,
    }], { writerGeneration: generation });
    const body = JSON.parse(readFileSync(join(testHome, MODEL_METADATA_CACHE_FILENAME), "utf8")) as {
      models: Record<string, { contextWindow?: number }>;
    };
    expect(body.models[snapshotKey("together", "acme/chat-pro")]?.contextWindow).toBe(262_144);
  });

  test("hydrate trims rows beyond SNAPSHOT_MAX_ROWS", () => {
    const models: Record<string, { contextWindow: number; observedAt: string }> = {};
    for (let i = 0; i < 8_200; i += 1) {
      models[snapshotKey("bulk", `model-${i}`)] = {
        contextWindow: 32_000 + i,
        observedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      };
    }
    const path = join(testHome, MODEL_METADATA_CACHE_FILENAME);
    writeFileSync(path, `${JSON.stringify({ version: 1, models })}\n`);
    resetModelMetadataCacheForTests({ hydrateFromDisk: true });
    expect(readSnapshotLayer("bulk", "model-0")).toBeUndefined();
    expect(readSnapshotLayer("bulk", "model-8199")?.contextWindow).toBe(32_000 + 8_199);
  });

  test("generation reconcile drops snapshot rows for removed providers", async () => {
    persistLiveModelMetadata("kept", [{ id: "a", contextWindow: 100_000 }]);
    persistLiveModelMetadata("removed", [{ id: "b", contextWindow: 200_000 }]);
    const { reconcileModelMetadataSnapshot } = await import("../src/codex/catalog/model-metadata");
    expect(reconcileModelMetadataSnapshot({
      generation: 1,
      providerNames: new Set(["kept"]),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    })).toBe(1);
    expect(readSnapshotLayer("kept", "a")?.contextWindow).toBe(100_000);
    expect(readSnapshotLayer("removed", "b")).toBeUndefined();
  });
});
