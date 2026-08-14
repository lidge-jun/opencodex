import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import {
  DEFAULT_VISION_TIMEOUT_MS,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
  resolveMaxDescriptionsPerTurn,
  resolveVisionTimeoutMs,
} from "../src/vision";
import { ManagementRequest as Request } from "./helpers/management-auth";

async function getSidecarSettings(config: OcxConfig): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url), url, config);
  if (!response) throw new Error("sidecar settings route did not handle GET");
  return response;
}

async function putSidecarSettings(
  config: OcxConfig,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle PUT");
  return response;
}

function emptyConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "none",
    providers: {},
    ...overrides,
  } as OcxConfig;
}

const FULL_VISION = {
  enabled: true,
  model: "gpt-5.6-luna",
  backend: "openai" as const,
  reasoning: "medium" as const,
  maxDescriptionsPerTurn: 6,
  timeoutMs: 30_000,
};

describe("sidecar-settings remaining vision controls", () => {
  let previousHome: string | undefined;
  let isolatedHome: string | undefined;

  function persistedVision(): Record<string, unknown> | undefined {
    const raw = JSON.parse(readFileSync(join(isolatedHome!, "config.json"), "utf8")) as {
      visionSidecar?: Record<string, unknown>;
    };
    return raw.visionSidecar;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-sidecar-vision-controls-"));
    process.env.OPENCODEX_HOME = isolatedHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
  });

  test("GET returns every Dashboard-managed Vision setting, including defaults", async () => {
    const unset = await getSidecarSettings(emptyConfig());
    expect(unset.status).toBe(200);
    expect((await unset.json() as { vision: Record<string, unknown> }).vision).toMatchObject({
      enabled: true,
      model: "gpt-5.4-mini",
      reasoning: "low",
      maxDescriptionsPerTurn: resolveMaxDescriptionsPerTurn(undefined),
      timeoutMs: DEFAULT_VISION_TIMEOUT_MS,
    });

    const configured = await getSidecarSettings(emptyConfig({
      visionSidecar: { ...FULL_VISION, enabled: false },
    }));
    expect((await configured.json() as { vision: Record<string, unknown> }).vision).toMatchObject({
      enabled: false,
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "medium",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });
  });

  test("PUT can update enabled, maxDescriptionsPerTurn, and timeoutMs independently", async () => {
    const config = emptyConfig({ visionSidecar: { ...FULL_VISION } });

    const enabled = await putSidecarSettings(config, { vision: { enabled: false } });
    expect(enabled.status).toBe(200);
    expect((await enabled.json() as { vision: { enabled: boolean } }).vision.enabled).toBe(false);
    expect(config.visionSidecar).toMatchObject({
      enabled: false,
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "medium",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });

    const limit = await putSidecarSettings(config, { vision: { maxDescriptionsPerTurn: 3 } });
    expect(limit.status).toBe(200);
    expect((await limit.json() as { vision: { maxDescriptionsPerTurn: number } }).vision.maxDescriptionsPerTurn).toBe(3);
    expect(config.visionSidecar?.enabled).toBe(false);
    expect(config.visionSidecar?.timeoutMs).toBe(30_000);

    const timeout = await putSidecarSettings(config, { vision: { timeoutMs: 12_000 } });
    expect(timeout.status).toBe(200);
    expect((await timeout.json() as { vision: { timeoutMs: number } }).vision.timeoutMs).toBe(12_000);
    expect(config.visionSidecar?.maxDescriptionsPerTurn).toBe(3);
    expect(persistedVision()?.timeoutMs).toBe(12_000);
  });

  test("partial updates preserve fields that were not supplied", async () => {
    const config = emptyConfig({ visionSidecar: { ...FULL_VISION } });
    const response = await putSidecarSettings(config, { vision: { reasoning: "high" } });
    expect(response.status).toBe(200);
    expect(config.visionSidecar).toMatchObject({
      enabled: true,
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "high",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });
  });

  test("PUT rejects invalid booleans, integers, and out-of-range timeoutMs without mutation", async () => {
    const config = emptyConfig({ visionSidecar: { ...FULL_VISION } });
    const snapshot = { ...config.visionSidecar };

    for (const vision of [
      { enabled: "true" },
      { enabled: 1 },
      { enabled: 0 },
      { enabled: null },
      { maxDescriptionsPerTurn: 0 },
      { maxDescriptionsPerTurn: -1 },
      { maxDescriptionsPerTurn: 1.5 },
      { maxDescriptionsPerTurn: "8" },
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 1.5 },
      { timeoutMs: "45000" },
      { timeoutMs: MIN_VISION_TIMEOUT_MS - 1 },
      { timeoutMs: MAX_VISION_TIMEOUT_MS + 1 },
    ]) {
      const response = await putSidecarSettings(config, { vision });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(config.visionSidecar).toEqual(snapshot);
    }
  });

  test("disable then re-enable keeps model, backend, reasoning, timeout, and limit", async () => {
    const config = emptyConfig({ visionSidecar: { ...FULL_VISION } });

    const disabled = await putSidecarSettings(config, { vision: { enabled: false } });
    expect(disabled.status).toBe(200);
    expect(config.visionSidecar).toMatchObject({
      enabled: false,
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "medium",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });

    const enabled = await putSidecarSettings(config, { vision: { enabled: true } });
    expect(enabled.status).toBe(200);
    expect((await enabled.json() as { vision: { enabled: boolean } }).vision.enabled).toBe(true);
    // true is the default — drop the key so a disable/re-enable cycle does not rewrite the file.
    expect("enabled" in (config.visionSidecar ?? {})).toBe(false);
    expect(config.visionSidecar).toMatchObject({
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "medium",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });
    expect(persistedVision()).toMatchObject({
      model: "gpt-5.6-luna",
      backend: "openai",
      reasoning: "medium",
      maxDescriptionsPerTurn: 6,
      timeoutMs: 30_000,
    });
  });

  test("an unrelated web-search save does not overwrite Vision settings", async () => {
    const config = emptyConfig({
      visionSidecar: { ...FULL_VISION, enabled: false },
      webSearchSidecar: { model: "gpt-5.6-luna" },
    });
    const response = await putSidecarSettings(config, {
      webSearch: { streamRoutedModelOutput: true },
    });
    expect(response.status).toBe(200);
    expect(config.webSearchSidecar?.streamRoutedModelOutput).toBe(true);
    expect(config.visionSidecar).toEqual({ ...FULL_VISION, enabled: false });
  });

  test("timeoutMs validation reuses the runtime bounds rather than a second contract", async () => {
    expect(resolveVisionTimeoutMs(undefined)).toBe(DEFAULT_VISION_TIMEOUT_MS);
    expect(resolveVisionTimeoutMs(MIN_VISION_TIMEOUT_MS)).toBe(MIN_VISION_TIMEOUT_MS);
    expect(resolveVisionTimeoutMs(MAX_VISION_TIMEOUT_MS)).toBe(MAX_VISION_TIMEOUT_MS);
    expect(resolveVisionTimeoutMs(MIN_VISION_TIMEOUT_MS - 1)).toBe(DEFAULT_VISION_TIMEOUT_MS);
    expect(resolveVisionTimeoutMs(MAX_VISION_TIMEOUT_MS + 1)).toBe(DEFAULT_VISION_TIMEOUT_MS);

    const config = emptyConfig();
    const minOk = await putSidecarSettings(config, { vision: { timeoutMs: MIN_VISION_TIMEOUT_MS } });
    expect(minOk.status).toBe(200);
    const maxOk = await putSidecarSettings(config, { vision: { timeoutMs: MAX_VISION_TIMEOUT_MS } });
    expect(maxOk.status).toBe(200);
    expect(config.visionSidecar?.timeoutMs).toBe(MAX_VISION_TIMEOUT_MS);
  });
});
