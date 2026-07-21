import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-test-1234" },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-models-patch-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-models-patch-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

async function patch(name: string, body: Record<string, unknown>, base: string) {
  return fetch(new URL(`/api/providers?name=${encodeURIComponent(name)}`, base), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/providers manual model list (liveModels / models)", () => {
  test("liveModels false + models persists to disk and survives a config reload", async () => {
    const server = startServer(0);
    try {
      const put = await patch("opencode-go", { liveModels: false, models: ["m1", "m2", "m2", " m1 "] }, server.url);
      expect(put.status).toBe(200);
      const body = (await put.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // GET /api/providers intentionally omits liveModels/models from its public DTO; verify
      // the persisted shape via loadConfig instead so the assertion stays close to the wire.
      const persisted = loadConfig().providers["opencode-go"]!;
      expect(persisted.liveModels).toBe(false);
      expect(persisted.models).toEqual(["m1", "m2"]);

      const reloaded = loadConfig();
      expect(reloaded.providers["opencode-go"]?.liveModels).toBe(false);
      expect(reloaded.providers["opencode-go"]?.models).toEqual(["m1", "m2"]);
    } finally {
      await server.stop(true);
    }
  });

  test("liveModels true re-enables auto-discovery and clears the manual flag", async () => {
    const server = startServer(0);
    try {
      await patch("opencode-go", { liveModels: false, models: ["m1"] }, server.url);
      const reenable = await patch("opencode-go", { liveModels: true }, server.url);
      expect(reenable.status).toBe(200);
      const persisted = loadConfig().providers["opencode-go"]!;
      expect(persisted.liveModels).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("models with non-string or whitespace-only elements are rejected with a 400", async () => {
    const server = startServer(0);
    try {
      const wrongType = await patch("opencode-go", { models: [123, "m1"] }, server.url);
      expect(wrongType.status).toBe(400);
      const empty = await patch("opencode-go", { models: [""] }, server.url);
      expect(empty.status).toBe(400);
      const blank = await patch("opencode-go", { models: ["   "] }, server.url);
      expect(blank.status).toBe(400);
      const notArr = await patch("opencode-go", { models: "m1" }, server.url);
      expect(notArr.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("empty models array deletes the models field on disk", async () => {
    const server = startServer(0);
    try {
      await patch("opencode-go", { liveModels: false, models: ["m1", "m2"] }, server.url);
      expect(loadConfig().providers["opencode-go"]?.models).toEqual(["m1", "m2"]);
      const clear = await patch("opencode-go", { models: [] }, server.url);
      expect(clear.status).toBe(200);
      expect(loadConfig().providers["opencode-go"]?.models).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("liveModels non-boolean is rejected with a 400", async () => {
    const server = startServer(0);
    try {
      const res = await patch("opencode-go", { liveModels: "yes" }, server.url);
      expect(res.status).toBe(400);
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      expect(body.error).toContain("liveModels");
    } finally {
      await server.stop(true);
    }
  });

  test("liveModels + models in the same patch represents a clean manual switch", async () => {
    const server = startServer(0);
    try {
      const put = await patch("opencode-go", { liveModels: false, models: ["a", "b"] }, server.url);
      expect(put.status).toBe(200);
      const persisted = loadConfig().providers["opencode-go"]!;
      expect(persisted.liveModels).toBe(false);
      expect(persisted.models).toEqual(["a", "b"]);
    } finally {
      await server.stop(true);
    }
  });
});
