import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function emptyConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "dummy",
    providers: { dummy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    ...overrides,
  } as OcxConfig;
}

async function getSettings(config: OcxConfig): Promise<Response> {
  const url = new URL("http://localhost/api/dictation-settings");
  const response = await handleManagementAPI(new Request(url), url, config);
  if (!response) throw new Error("dictation settings route did not handle GET");
  return response;
}

async function putSettings(config: OcxConfig, dictation: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/dictation-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dictation }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("dictation settings route did not handle PUT");
  return response;
}

describe("dictation-settings management route", () => {
  let previousHome: string | undefined;
  let isolatedHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-dictation-settings-"));
    process.env.OPENCODEX_HOME = isolatedHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (isolatedHome) removeTreeWithRetry(isolatedHome);
    isolatedHome = undefined;
  });

  test("GET reports the effective block and an available-model list", async () => {
    const response = await getSettings(emptyConfig({ dictation: { default: "openai" } }));
    expect(response.status).toBe(200);
    const body = await response.json() as { dictation: Record<string, unknown>; models: unknown };
    expect(body.dictation).toEqual({ default: "openai" });
    expect(Array.isArray(body.models)).toBe(true);
  });

  test("PUT persists a valid block and echoes it", async () => {
    const config = emptyConfig();
    const provider = { url: "wss://dictation.example.test/stream", protocols: ["dictation-v1"] };
    const response = await putSettings(config, {
      default: "custom",
      byModel: { "zai/glm-5.3-flash": "custom" },
      providers: { custom: provider },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; dictation: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.dictation).toEqual({ default: "custom", byModel: { "zai/glm-5.3-flash": "custom" }, providers: { custom: provider } });
    expect(loadConfig().dictation).toEqual(body.dictation);
  });

  test("PUT rejects an unknown target and leaves the stored block untouched", async () => {
    const config = emptyConfig({ dictation: { default: "openai" } });
    const response = await putSettings(config, { default: "ghost" });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("not a configured provider");
    // The rejected write never reached disk, so the in-memory block is untouched.
    expect(config.dictation).toEqual({ default: "openai" });
  });

  test("PUT with an empty block clears the key so the file stays minimal", async () => {
    const config = emptyConfig({ dictation: { default: "openai" } });
    const response = await putSettings(config, {});
    expect(response.status).toBe(200);
    expect(config.dictation).toBeUndefined();
    expect(loadConfig().dictation).toBeUndefined();
  });
});
