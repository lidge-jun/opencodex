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

  test("liveModels true persists explicit true so registry enrichment cannot restore false", async () => {
    const server = startServer(0);
    try {
      await patch("opencode-go", { liveModels: false, models: ["m1"] }, server.url);
      const reenable = await patch("opencode-go", { liveModels: true }, server.url);
      expect(reenable.status).toBe(200);
      const persisted = loadConfig().providers["opencode-go"]!;
      expect(persisted.liveModels).toBe(true);
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

// Unit-test variant for modelContextWindows: calls handleManagementAPI directly so the
// assertion does not depend on Bun.serve binding a port (which some CI/sandbox runtimes
// refuse for port 0). saveConfig still persists through OPENCODEX_HOME; refreshCodexCatalog
// is stubbed via deps so no live provider fetch happens.
import { handleManagementAPI } from "../src/server/management-api";

function baseProviderConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-test-1234" },
    },
  } as OcxConfig;
}

async function patchCtxWindows(name: string, body: Record<string, unknown>, config: OcxConfig) {
  const url = new URL(`/api/providers?name=${encodeURIComponent(name)}`, "http://127.0.0.1");
  const req = new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleManagementAPI(req, url, config, { refreshCodexCatalog: async () => {} });
}

describe("PATCH /api/providers modelContextWindows (unit)", () => {
  let prevHome: string | undefined;
  let dir: string;

  beforeEach(() => {
    prevHome = process.env.OPENCODEX_HOME;
    dir = mkdtempSync(join(tmpdir(), "ocx-ctxwin-"));
    process.env.OPENCODEX_HOME = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a valid map persists to disk and survives a config reload", async () => {
    const config = baseProviderConfig();
    saveConfig(config);
    const res = await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": 200_000, "m2": 128_000 } }, config);
    expect(res?.status).toBe(200);
    expect((await res!.json()).success).toBe(true);
    expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toEqual({ "m1": 200_000, "m2": 128_000 });
  });

  test("null clears the field on disk", async () => {
    const config = baseProviderConfig();
    config.providers["opencode-go"]!.modelContextWindows = { "m1": 200_000 };
    saveConfig(config);
    const res = await patchCtxWindows("opencode-go", { modelContextWindows: null }, config);
    expect(res?.status).toBe(200);
    expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toBeUndefined();
  });

  test("empty object clears the field on disk", async () => {
    const config = baseProviderConfig();
    config.providers["opencode-go"]!.modelContextWindows = { "m1": 200_000 };
    saveConfig(config);
    const res = await patchCtxWindows("opencode-go", { modelContextWindows: {} }, config);
    expect(res?.status).toBe(200);
    expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toBeUndefined();
  });

  test("replacement semantics: a second PATCH overwrites, not merges", async () => {
    const config = baseProviderConfig();
    saveConfig(config);
    await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": 200_000, "m2": 128_000 } }, config);
    await patchCtxWindows("opencode-go", { modelContextWindows: { "m3": 1_000_000 } }, config);
    expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toEqual({ "m3": 1_000_000 });
  });

  test("non-integer values are rejected with a 400", async () => {
    const config = baseProviderConfig();
    saveConfig(config);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": 1.5 } }, config))?.status).toBe(400);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": -100 } }, config))?.status).toBe(400);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": 0 } }, config))?.status).toBe(400);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": "big" } }, config))?.status).toBe(400);
  });

  test("non-object values are rejected with a 400", async () => {
    const config = baseProviderConfig();
    saveConfig(config);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: [200_000] }, config))?.status).toBe(400);
    expect((await patchCtxWindows("opencode-go", { modelContextWindows: 200_000 }, config))?.status).toBe(400);
  });

  test("blank model ids are dropped after trim", async () => {
    const config = baseProviderConfig();
    saveConfig(config);
    const res = await patchCtxWindows("opencode-go", { modelContextWindows: { "m1": 200_000, "   ": 128_000 } }, config);
    expect(res?.status).toBe(200);
    expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toEqual({ "m1": 200_000 });
  });
});
