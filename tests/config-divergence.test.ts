import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  armClaudeCodeBaseline,
  getConfigPath,
  loadConfig,
  mutatePersistedConfig,
  readConfigDivergenceStatus,
  reconcileLiveConfigFromDisk,
  refreshResidentConfigIdentity,
  saveConfig,
  saveConfigPreservingClaudeCode,
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

  test("a missing config file after arming is divergent and a different restore is caught", async () => {
    const bytes = JSON.stringify(config(), null, 2) + "\n";
    writeFileSync(getConfigPath(), bytes);
    const loaded = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(loaded);
    expect(readConfigDivergenceStatus().residentVersion).not.toBeNull();
    // Deleting a file-backed config diverges: a restart would serve defaults, so
    // the read must report it AND keep the resident identity (the GUI polls every 15s).
    rmSync(getConfigPath());
    let status = readConfigDivergenceStatus();
    expect(status.diskVersion).toBeNull();
    expect(status.diverged).toBe(true);
    expect(status.residentVersion).not.toBeNull();
    // Restoring the original bytes: still in sync.
    writeFileSync(getConfigPath(), bytes);
    status = readConfigDivergenceStatus();
    expect(status.diskVersion).not.toBeNull();
    expect(status.diverged).toBe(false);
    // Restoring DIFFERENT bytes without a reload must flip diverged: the running
    // process still serves the admission snapshot.
    writeFileSync(getConfigPath(), JSON.stringify(config(20200), null, 2) + "\n");
    status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(true);
  });

  test("a config that appears after a defaults-backed start is divergent", () => {
    // No config.json exists yet: the server arms a defaults-backed resident.
    const loaded = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(loaded);
    expect(readConfigDivergenceStatus().diverged).toBe(false);
    // A config.json now appears: a restart would serve it instead of defaults.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const status = readConfigDivergenceStatus();
    expect(status.residentVersion).toBeNull();
    expect(status.diskVersion).not.toBeNull();
    expect(status.diverged).toBe(true);
  });

  test("a corrupt config repaired after arming a defaults-backed resident is divergent", () => {
    // A broken config falls back to getDefaultConfig(); the resident must be
    // recorded as defaults-backed so a later repair (which a restart would now
    // serve) is reported instead of silently staying "in sync" forever.
    writeFileSync(getConfigPath(), "{ this is not valid json !!");
    const loaded = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(loaded);
    // The operator repairs config.json: a restart would now serve the real file.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const status = readConfigDivergenceStatus();
    expect(status.residentVersion).toBeNull();
    expect(status.diskVersion).not.toBeNull();
    expect(status.diverged).toBe(true);
  });

  test("external disk edit after arming flips diverged", async () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
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

  test("an incidental loadConfig call does not wipe the armed divergence", () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(false);
    // Simulate an external editor / another process rewriting config.json.
    const path = getConfigPath();
    const current = JSON.parse(readFileSync(path, "utf8")) as { port: number };
    current.port = 20200;
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    expect(readConfigDivergenceStatus().diverged).toBe(true);
    // Runtime components re-read the file (sync, catalog, injection) without capture;
    // that must not make the armed process believe it already runs the new bytes.
    loadConfig();
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(true);
    expect(status.residentVersion).not.toBe(status.diskVersion);
  });

  test("a disk-first mutation keeps divergence for an unrouted disk-only row", () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    // An external editor adds a provider the live config never saw.
    const path = getConfigPath();
    const current = JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown> };
    current.providers.diskOnly = { adapter: "openai-chat", baseUrl: "https://disk.example/v1", apiKey: "sk-disk" };
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    // A disk-first mutation preserves the disk-only row but does not adopt it into
    // the running config; the resident identity must not be refreshed to the file.
    const outcome = mutatePersistedConfig(persisted => {
      persisted.port = 10600;
      return { changed: true, value: true };
    });
    expect(outcome.status).toBe("committed");
    expect(readConfigDivergenceStatus().diverged).toBe(true);
  });

  test("an adopter re-anchors the resident identity after mirroring a disk-first mutation", () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    // A disk-first mutation writes the change but cannot refresh the resident
    // identity: the server may or may not adopt the document.
    const outcome = mutatePersistedConfig(persisted => {
      persisted.port = 10600;
      return { changed: true, value: true };
    });
    expect(outcome.status).toBe("committed");
    expect(readConfigDivergenceStatus().diverged).toBe(true);
    // The adopter mirrors the committed change into the long-lived served config
    // and then re-anchors the identity to that served snapshot.
    armed.port = 10600;
    refreshResidentConfigIdentity(armed);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("the refresh helper keeps divergence while a preserved disk-only row is unrouted", () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    // An external editor adds a provider the live config never saw.
    const path = getConfigPath();
    const current = JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown> };
    current.providers.diskOnly = { adapter: "openai-chat", baseUrl: "https://disk.example/v1", apiKey: "sk-disk" };
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    const outcome = mutatePersistedConfig(persisted => {
      persisted.port = 10600;
      return { changed: true, value: true };
    });
    expect(outcome.status).toBe("committed");
    // The adopter mirrors only the mutation it knows about; the disk-only row is
    // still not routed, so re-anchoring to the served snapshot must keep diverged.
    armed.port = 10600;
    refreshResidentConfigIdentity(armed);
    expect(readConfigDivergenceStatus().diverged).toBe(true);
  });

  test("adopter refresh matches the sorted committed provenance bytes", () => {
    // The file carries unsorted deletion keys; the persisted projection sorts
    // them, so the adopter's re-anchor must hash the projected form instead of
    // the raw runtime object (which retains the original array order).
    writeFileSync(getConfigPath(), JSON.stringify({
      ...config(),
      configRebaseProvenance: { version: 1, deletedTopLevelKeys: ["providers", "combos"] },
    }, null, 2) + "\n");
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    const outcome = mutatePersistedConfig(persisted => {
      persisted.port = 10600;
      return { changed: true, value: true };
    });
    expect(outcome.status).toBe("committed");
    expect(readConfigDivergenceStatus().diverged).toBe(true);
    // The adopter mirrors the committed change and re-anchors.
    armed.port = 10600;
    refreshResidentConfigIdentity(armed);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("the refresh helper no-ops when no resident identity is armed", () => {
    // A fresh process that never saved nor ran an admission load has no identity.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const unarmed = loadConfig();
    refreshResidentConfigIdentity(unarmed);
    expect(readConfigDivergenceStatus().residentVersion).toBeNull();
  });

  test("a guarded save keeps divergence when the persisted binding differs from the live socket", () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(armed);
    // Another process changes the disk port: the desired next-start binding.
    const path = getConfigPath();
    const current = JSON.parse(readFileSync(path, "utf8")) as { port: number };
    current.port = 20200;
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    // OAuth reconciliation adopts the new desired binding on disk while the live
    // socket keeps its actual binding.
    reconcileLiveConfigFromDisk(armed, structuredClone(armed));
    armed.streamMode = "eager-relay";
    saveConfigPreservingClaudeCode(armed);
    const status = readConfigDivergenceStatus();
    // The file says port 20200; the running proxy still serves port 10100, so the
    // resident digest must follow the served snapshot and keep diverged=true.
    expect(status.diverged).toBe(true);
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

  test("a byte-identical save re-anchors the resident identity when the served bytes match the file", () => {
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const live = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(live);
    // Simulate a stale resident identity: the running object equals the current
    // file, but the resident digest was armed from an older document.
    const staleDigest = createHash("sha256").update(JSON.stringify(config(20200), null, 2) + "\n").digest("hex");
    setResidentConfigSha256ForTests(staleDigest);
    expect(readConfigDivergenceStatus().diverged).toBe(true);

    // An unrelated save that is byte-identical must re-anchor the resident digest:
    // the served snapshot serializes to the exact persisted bytes, so the stale
    // digest is a false positive (external canonicalization already applied).
    saveConfigPreservingClaudeCode(live);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(false);
    expect(status.residentVersion).toBe(status.diskVersion);
  });

  test("an unchanged save with preserved disk-only bytes keeps divergence when the served snapshot omits them", () => {
    // A later byte-identical save must not re-anchor the resident digest to the
    // merged file bytes: the served snapshot still omits the disk-only row, so
    // re-anchoring would report a false negative for an actual divergence.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const loaded = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(loaded);
    // An external editor adds a provider the live config never saw.
    const path = getConfigPath();
    const current = JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown> };
    current.providers.diskOnly = { adapter: "openai-chat", baseUrl: "https://disk.example/v1", apiKey: "sk-disk" };
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    reconcileUserCostOverlaysFromDisk(loaded);
    // First save establishes the persisted bytes (the disk-only row survives at
    // the serialization boundary while the served snapshot omits it).
    loaded.streamMode = "eager-relay";
    saveConfigPreservingClaudeCode(loaded);
    expect(readConfigDivergenceStatus().diverged).toBe(true);
    // Second, byte-identical save reaches the unchanged branch with
    // servedBytes !== bytes; the guard must leave divergence visible.
    saveConfigPreservingClaudeCode(loaded);
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(true);
    expect(status.residentVersion).not.toBe(status.diskVersion);
  });

  test("resident digest comes from the loaded bytes, not a post-load re-read", async () => {
    const first = JSON.stringify(config(), null, 2) + "\n";
    writeFileSync(getConfigPath(), first);
    const loaded = loadConfig({ captureResident: true });
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

  test("resident digest hashes the raw file bytes, not the decoded string", () => {
    // A malformed UTF-8 byte inside a JSON string value decodes to U+FFFD; the
    // digest must still match the file's exact byte SHA-256.
    const rawBytes = Buffer.concat([
      Buffer.from('{"port":10100,"note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]);
    writeFileSync(getConfigPath(), rawBytes);
    loadConfig({ captureResident: true });
    const status = readConfigDivergenceStatus();
    const byteDigest = createHash("sha256").update(rawBytes).digest("hex");
    const decodedDigest = createHash("sha256").update(rawBytes.toString("utf-8")).digest("hex");
    expect(byteDigest).not.toBe(decodedDigest);
    expect(status.residentVersion).toBe(byteDigest);
  });

  test("a save that preserves disk-only providers stays diverged until the row is routed", async () => {
    // Start with only the existing provider; the disk-only row arrives as an EXTERNAL
    // edit after the process armed its resident identity.
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const loaded = loadConfig({ captureResident: true });
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
    // The served config does not route diskOnly yet, so the warning stays on even
    // though the merged file on disk includes the row (Option A: resident identity
    // is bound to the served snapshot, not the last merged write).
    expect(status.diverged).toBe(true);
    expect(status.residentVersion).not.toBe(status.diskVersion);
    const persisted = JSON.parse(await Bun.file(getConfigPath()).text()) as { providers: Record<string, unknown> };
    expect(persisted.providers.diskOnly).toBeDefined();
  });

  test("an external edit to a preserved disk-only row still flips diverged", async () => {
    writeFileSync(getConfigPath(), JSON.stringify(config(), null, 2) + "\n");
    const loaded = loadConfig({ captureResident: true });
    armClaudeCodeBaseline(loaded);
    writeFileSync(getConfigPath(), JSON.stringify({
      ...config(),
      providers: {
        ...(config().providers as Record<string, unknown>),
        diskOnly: { adapter: "openai-chat", baseUrl: "https://disk.example/v1", apiKey: "sk-disk" },
      },
    }, null, 2) + "\n");
    reconcileUserCostOverlaysFromDisk(loaded);
    saveConfig(loaded);
    // The file the proxy last wrote includes the preserved disk-only row; editing that
    // row is still a real file change that a restart applies (the row becomes live
    // routing after restart), so the warning must not be hidden.
    const path = getConfigPath();
    const current = JSON.parse(await Bun.file(path).text()) as { providers: Record<string, { baseUrl?: string }> };
    current.providers.diskOnly.baseUrl = "https://disk.example/v2";
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
    const status = readConfigDivergenceStatus();
    expect(status.diverged).toBe(true);
  });

  test("GET /api/config/status exposes resident and disk versions", async () => {
    saveConfig(config());
    const armed = loadConfig({ captureResident: true });
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
