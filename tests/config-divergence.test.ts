import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  armClaudeCodeBaseline,
  getConfigPath,
  loadConfig,
  readConfigDivergenceStatus,
  saveConfig,
  setResidentConfigSha256ForTests,
} from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { reconcileUserCostOverlaysFromDisk } from "../src/usage/user-cost-overlay-reconciler";
import type { OcxConfig } from "../src/types";

let testRoot = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-config-divergence-"));
  process.env.OPENCODEX_HOME = testRoot;
  setResidentConfigSha256ForTests(null);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testRoot, { recursive: true, force: true });
});

function config(port = 10100): OcxConfig {
  return {
    port,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret",
      },
    },
  } as unknown as OcxConfig;
}

describe("config divergence status", () => {
  test("unarmed process reports no divergence (resident unknown)", () => {
    // A process that never armed a live baseline nor saved (e.g. `ocx status`) has no
    // resident identity to compare; it must never claim divergence.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const status = readConfigDivergenceStatus();
    expect(status.residentVersion).toBeNull();
    expect(status.diskVersion).not.toBeNull();
    expect(status.diverged).toBe(false);
  });

  test("deleting the config clears the resident identity instead of retaining stale bytes", async () => {
    const bytes = JSON.stringify(config(), null, 2) + "\n";
    writeFileSync(getConfigPath(), bytes);
    const loaded = loadConfig();
    armClaudeCodeBaseline(loaded);
    expect(readConfigDivergenceStatus().residentVersion).not.toBeNull();
    rmSync(getConfigPath());
    loadConfig();
    expect(readConfigDivergenceStatus().residentVersion).toBeNull();
    // Restoring the original bytes must not resurrect a stale divergence claim: with
    // no resident identity the process cannot assert the file differs from it.
    writeFileSync(getConfigPath(), bytes);
    const status = readConfigDivergenceStatus();
    expect(status.diskVersion).not.toBeNull();
    expect(status.diverged).toBe(false);
  });

  test("external disk edit after arming flips diverged", async () => {
    saveConfig(config());
    const armed = loadConfig();
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);
    // Simulate an external editor / another process rewriting config.json.
    const path = getConfigPath();
    const current = JSON.parse(await Bun.file(path).text());
    current.port = 20200;
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(true);
    expect(status.residentVersion).not.toBe(status.diskVersion);
  });

  test("an in-process save refreshes the resident version", () => {
    saveConfig(config());
    const armed = loadConfig();
    armClaudeCodeBaseline(armed);
    armed.port = 20200;
    saveConfig(armed);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("resident digest comes from the loaded bytes, not a post-load re-read", async () => {
    const first = JSON.stringify(config(), null, 2) + "\n";
    writeFileSync(getConfigPath(), first);
    const loaded = loadConfig();
    // The file changes between load and arming (e.g. another process saves during startup).
    const second = JSON.stringify(config(20200), null, 2) + "\n";
    writeFileSync(getConfigPath(), second);
    armClaudeCodeBaseline(loaded);
    const status = readConfigDivergenceStatus();
    // Resident identity is the bytes that PRODUCED the live config (first), so the
    // newer disk bytes are a real divergence the running process has not applied.
    expect(status.residentVersion).toBe(createHash("sha256").update(first).digest("hex"));
    expect(status.diverged).toBe(true);
  });

  test("a save that preserves disk-only providers does not false-positive", async () => {
    // Start with only the existing provider; the disk-only row arrives as an EXTERNAL
    // edit after the process armed its resident identity.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const loaded = loadConfig();
    armClaudeCodeBaseline(loaded);
    writeFileSync(getConfigPath(), JSON.stringify({
      ...config(),
      providers: {
        ...(config().providers as Record<string, unknown>),
        diskOnly: { adapter: "openai-chat", baseUrl: "https://disk.example/v1", apiKey: "sk-disk" },
      },
    }, null, 2) + "\n");
    // The production server notices the external edit via its cost-overlay reconciler
    // poll; drive that same step so the save below preserves the disk-only row.
    reconcileUserCostOverlaysFromDisk(loaded);
    // Live edit adds a provider; persistConfigUnlocked preserves the disk-only row.
    loaded.providers.live = { adapter: "openai-chat", baseUrl: "https://live.example/v1", apiKey: "sk-live" };
    saveConfig(loaded);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
    const persisted = JSON.parse(await Bun.file(getConfigPath()).text()) as { providers: Record<string, unknown> };
    expect(persisted.providers.diskOnly).toBeDefined();
  });

  test("GET /api/config/status exposes resident and disk versions", async () => {
    saveConfig(config());
    const armed = loadConfig();
    armClaudeCodeBaseline(armed);
    const response = await handleManagementAPI(
      new Request("http://127.0.0.1:10100/api/config/status", { headers: { Host: "127.0.0.1:10100" } }),
      new URL("http://127.0.0.1:10100/api/config/status"),
      armed,
    );
    expect(response).not.toBeNull();
    const body = await response!.json() as { residentVersion?: unknown; diskVersion?: unknown; diverged?: unknown };
    expect(body.diverged).toBe(false);
    expect(typeof body.residentVersion).toBe("string");
    expect(typeof body.diskVersion).toBe("string");
  });
});
