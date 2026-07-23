/**
 * /api/settings streamMode surface (#314 WP1) + config persistence round-trip.
 *
 * streamMode is persisted in config.json (Windows services do not inherit
 * shell env), degraded to "auto" with a warning when the persisted value is
 * invalid (must never trip loadConfig's backup-and-defaults repair path), and
 * settable alone via PUT (legacy codexAutoStart-only PUTs keep working).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { invalidateStartupHealthCache } from "../src/server/startup-health-cache";
import type { OcxConfig } from "../src/types";

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

function putSettings(config: OcxConfig, body: unknown): Promise<Response | null> {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config);
}

function getSettings(config: OcxConfig): Promise<Response | null> {
  const req = new Request("http://127.0.0.1:10100/api/settings");
  return handleManagementAPI(req, new URL(req.url), config);
}

beforeEach(() => {
  invalidateStartupHealthCache();
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-settings-stream-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      /* Windows may briefly lock while a background startup-health probe exits */
    }
  }
});

describe("GET /api/settings", () => {
  test("reports streamMode auto by default", async () => {
    const config = baseConfig();
    const res = await getSettings(config);
    expect(res).not.toBeNull();
    const body = await res!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("auto");
  });

  test("reports a persisted non-auto streamMode", async () => {
    const config = { ...baseConfig(), streamMode: "eager-relay" as const };
    const body = await (await getSettings(config))!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("eager-relay");
  });

  test("reports redacted codexRuntime diagnostics and clamp correlation", async () => {
    const { persistCodexRuntime, persistEffortClamp, resetCodexRuntimeResolveCacheForTests } = await import("../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();
    persistCodexRuntime({
      command: join(TEST_DIR, "Users", "Alice", "codex.exe"),
      version: "0.133.0",
      source: "configured",
    }, { configDir: TEST_DIR });
    persistEffortClamp({
      runtimePath: join(TEST_DIR, "Users", "Alice", "codex.exe"),
      runtimeVersion: "0.133.0",
      removedEfforts: ["max", "ultra"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir: TEST_DIR });

    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    try {
      process.env.CODEX_CLI_PATH = join(TEST_DIR, "Users", "Alice", "codex.exe");
      process.env.PATH = "";
      // Force resolve to use the persisted/env path without spawning a real Codex.
      // The settings handler catches resolve failures; probe will fail existence and fall back.
      const body = await (await getSettings(baseConfig()))!.json() as {
        codexRuntime?: {
          path?: string;
          version?: string | null;
          source?: string;
          warning?: string | null;
          newerAvailable?: { path?: string; version?: string | null } | null;
          catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
        };
      };
      expect(typeof body.codexRuntime?.path).toBe("string");
      expect(body.codexRuntime?.path?.toLowerCase()).not.toContain("alice");
      expect(
        body.codexRuntime?.newerAvailable === null
        || (typeof body.codexRuntime?.newerAvailable === "object" && body.codexRuntime?.newerAvailable !== null),
      ).toBe(true);
      expect(body.codexRuntime?.warning === null || typeof body.codexRuntime?.warning === "string").toBe(true);
      expect(Array.isArray(body.codexRuntime?.catalogClamp?.removedEfforts)).toBe(true);
      expect(
        body.codexRuntime?.catalogClamp?.runtimeVersion === null
        || typeof body.codexRuntime?.catalogClamp?.runtimeVersion === "string",
      ).toBe(true);
    } finally {
      if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCli;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });
});

describe("PUT /api/settings", () => {
  test("legacy codexAutoStart-only PUT still works (regression)", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { codexAutoStart: true });
    expect(res!.status).toBe(200);
    expect(config.codexAutoStart).toBe(true);
  });

  test("streamMode-only PUT works (Windows service escape hatch)", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { streamMode: "eager-relay" });
    expect(res!.status).toBe(200);
    const body = await res!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("eager-relay");
    expect(config.streamMode).toBe("eager-relay");
  });

  test("auto normalizes to key removal, persisted round-trip drops it", async () => {
    const config = { ...baseConfig(), streamMode: "legacy-tee" as const };
    const res = await putSettings(config, { streamMode: "auto" });
    expect(res!.status).toBe(200);
    expect(config.streamMode).toBeUndefined();
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
    expect("streamMode" in raw).toBe(false);
  });

  test("non-auto value persists and survives loadConfig", async () => {
    const config = baseConfig();
    await putSettings(config, { streamMode: "legacy-tee" });
    const reloaded = loadConfig();
    expect(reloaded.streamMode).toBe("legacy-tee");
  });

  test("rejects invalid streamMode with 400", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { streamMode: "bogus" });
    expect(res!.status).toBe(400);
    const body = await res!.json() as { error?: string };
    expect(body.error).toContain("streamMode");
  });

  test("rejects empty body with 400", async () => {
    const config = baseConfig();
    const res = await putSettings(config, {});
    expect(res!.status).toBe(400);
  });
});

describe("config.json schema resilience", () => {
  test("invalid persisted streamMode degrades to auto without nuking the config", () => {
    const config = { ...baseConfig(), streamMode: "eager-relay" as const };
    saveConfig(config);
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
    raw.streamMode = "legacy_tee"; // hand-edit typo
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    const reloaded = loadConfig();
    // Degraded, not defaulted: providers must survive.
    expect(reloaded.streamMode).toBeUndefined();
    expect(reloaded.providers.openai).toBeDefined();
    expect(reloaded.providers.openai!.apiKey).toBe("sk-secret-value");
  });

  test("valid persisted streamMode round-trips through loadConfig", () => {
    const config = { ...baseConfig(), streamMode: "legacy-tee" as const };
    saveConfig(config);
    expect(loadConfig().streamMode).toBe("legacy-tee");
  });
});
