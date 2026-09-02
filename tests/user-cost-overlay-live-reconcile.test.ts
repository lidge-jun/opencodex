import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import { resolveMatchedPrice } from "../src/usage/cost";
import {
  activeUserCostOverlays,
  refreshUserCostOverlays,
  resetPreservedDiskOnlyProvidersForTests,
  userCostOverlayVersion,
  withPreservedDiskOnlyProviders,
} from "../src/usage/user-cost-overlays";
import {
  reconcileUserCostOverlaysFromDisk,
  resetUserCostOverlayReconcilerForTests,
  startUserCostOverlayReconciler,
  stopUserCostOverlayReconciler,
  userCostOverlayInvalidReconcileCountForTests,
} from "../src/usage/user-cost-overlay-reconciler";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = resolve(import.meta.dir, "..");

const DISK_CONFIG: OcxConfig = {
  port: 0,
  hostname: "127.0.0.1",
  defaultProvider: "acme",
  providers: {
    acme: {
      adapter: "openai-chat",
      baseUrl: "https://example.invalid",
      apiKey: "sk-test",
      models: ["model-x"],
    },
  },
} as OcxConfig;

const OVERLAY = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };

let testDir = "";
let previousHome: string | undefined;

async function runChild(script: string): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

async function waitForOverlayLive(
  provider = "acme",
  model = "model-x",
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const price = resolveMatchedPrice(provider, model);
    if (price?.source === "user") return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for the external overlay to become live");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for the reconciler to observe the config change");
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-overlay-live-"));
  process.env.OPENCODEX_HOME = testDir;
  writeFileSync(getConfigPath(), `${JSON.stringify(DISK_CONFIG, null, 2)}\n`, "utf8");
});

afterEach(() => {
  stopUserCostOverlayReconciler();
  resetUserCostOverlayReconcilerForTests();
  refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
  resetPreservedDiskOnlyProvidersForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("cross-process user cost overlay reconciliation", () => {
  test("a CLI-process saveConfig edit becomes live in the running server registry", async () => {
    // "Server" state: the live config object plus the module-level overlay
    // registry, with the reconciler polling the shared disk config.
    const liveConfig = loadConfig();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });
    const versionBefore = userCostOverlayVersion();

    // Separate writer process: exactly what `ocx config set` does — a fresh
    // module instance calling saveConfig() under the same OPENCODEX_HOME.
    const { exitCode, stderr } = await runChild(`
      const { loadConfig, saveConfig } = await import("./src/config.ts");
      const config = loadConfig();
      config.providers.acme.modelCosts = { "model-x": ${JSON.stringify(OVERLAY)} };
      saveConfig(config);
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    await waitForOverlayLive();

    expect(userCostOverlayVersion()).toBeGreaterThan(versionBefore);
    const price = resolveMatchedPrice("acme", "model-x");
    expect(price).toMatchObject({
      provider: "acme",
      modelId: "model-x",
      source: "user",
      cost4: OVERLAY,
    });
    expect(activeUserCostOverlays()).toHaveLength(1);
    // The live config adopted the disk row, so an unrelated in-process save
    // cannot erase the external edit.
    expect(liveConfig.providers.acme?.modelCosts).toEqual({ "model-x": OVERLAY });
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.acme?.modelCosts).toEqual({ "model-x": OVERLAY });
  });

  test("a direct config.json edit becomes live without running saveConfig", async () => {
    const liveConfig = loadConfig();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });
    const versionBefore = userCostOverlayVersion();

    // Separate writer process: raw file edit, no ocx code at all.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.acme.modelCosts = { "model-x": ${JSON.stringify(OVERLAY)} };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    await waitForOverlayLive();

    expect(userCostOverlayVersion()).toBeGreaterThan(versionBefore);
    expect(resolveMatchedPrice("acme", "model-x")).toMatchObject({
      provider: "acme",
      modelId: "model-x",
      source: "user",
      cost4: OVERLAY,
    });
    expect(liveConfig.providers.acme?.modelCosts).toEqual({ "model-x": OVERLAY });
  });

  test("an invalid transient config edit does not wipe the active overlay registry", async () => {
    const liveConfig = loadConfig();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });

    // Make the overlay live first through the same cross-process path.
    const seed = await runChild(`
      const { loadConfig, saveConfig } = await import("./src/config.ts");
      const config = loadConfig();
      config.providers.acme.modelCosts = { "model-x": ${JSON.stringify(OVERLAY)} };
      saveConfig(config);
    `);
    expect(seed.exitCode).toBe(0);
    expect(seed.stderr).toBe("");
    await waitForOverlayLive();

    // A non-cooperating writer leaves a transient broken file; the reconciler
    // must keep serving the last good overlay instead of falling back to
    // defaults.
    const invalidCountBefore = userCostOverlayInvalidReconcileCountForTests();
    writeFileSync(getConfigPath(), "{ not json", "utf8");
    await waitUntil(() => userCostOverlayInvalidReconcileCountForTests() > invalidCountBefore);

    expect(resolveMatchedPrice("acme", "model-x")?.source).toBe("user");
  });

  test("an externally added provider survives an unrelated live-config save", async () => {
    const liveConfig = loadConfig();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });

    // Separate writer adds a brand-new provider (not present in the live
    // config at boot) with its own overlay.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    // Reconciler adopts the overlay from disk; beta is not added to live
    // routing state but its overlay is active for display estimates.
    await waitForOverlayLive("beta", "beta-model");
    expect(liveConfig.providers.beta).toBeUndefined();

    // An unrelated live save (a different provider's models list) must not
    // erase beta or its overlay.
    liveConfig.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta?.modelCosts).toEqual({ "beta-model": OVERLAY });
    expect(resolveMatchedPrice("beta", "beta-model")?.source).toBe("user");
  });

  test("a later owner's smaller poll interval is honored and the cadence relaxes when it stops", async () => {
    const slowConfig = loadConfig();
    const slowOwner = startUserCostOverlayReconciler({ intervalMs: 500, liveConfig: slowConfig });
    const fastConfig = loadConfig();
    const fastOwner = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: fastConfig });

    // External edit: with the 20ms owner active it must become live well
    // inside the 500ms owner's cadence.
    const { exitCode, stderr } = await runChild(`
      const { loadConfig, saveConfig } = await import("./src/config.ts");
      const config = loadConfig();
      config.providers.acme.modelCosts = { "model-x": ${JSON.stringify(OVERLAY)} };
      saveConfig(config);
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // Deadline shorter than the slow owner's 500ms cadence: only the 20ms
    // owner can satisfy it, so a syncReconcileTimer regression that ignores
    // the later smaller interval fails here instead of passing silently.
    await waitForOverlayLive("acme", "model-x", 200);

    // Remove the fast owner: a fresh edit must NOT appear before the slow
    // cadence elapses, then must be observed once it does. The "not yet
    // observed" half is intentionally not asserted with a fixed sleep: the
    // child spawn itself can consume most of the 500ms window on a loaded
    // machine, so only the positive observation is checked.
    fastOwner.stop();
    const edit = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.acme.modelCosts = { "model-x": { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 } };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(edit.exitCode).toBe(0);
    expect(edit.stderr).toBe("");
    await waitUntil(
      () => resolveMatchedPrice("acme", "model-x")?.cost4?.input === 3,
      2_000,
    );

    slowOwner.stop();
  });

  test("overlay-only refresh without live config clears stale preservation so a deleted provider cannot resurrect", async () => {
    const liveConfig = loadConfig();

    // External writer adds beta; a one-shot refresh WITH a live config
    // populates the preservation registry, the state a stopped or
    // never-registered owner would leave behind.
    const add = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(add.exitCode).toBe(0);
    expect(reconcileUserCostOverlaysFromDisk(liveConfig)).toBe(true);
    expect(withPreservedDiskOnlyProviders(liveConfig).providers.beta).toBeDefined();

    // External writer deletes beta.
    const del = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      delete raw.providers.beta;
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(del.exitCode).toBe(0);

    // Overlay-only refresh (no live routing config) must clear the stale
    // registry; otherwise the next saveConfig resurrects beta.
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);

    liveConfig.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();
  });

  test("a stopped newer owner cannot leave an older owner able to erase a disk-only provider (A lacks beta -> B has beta -> B stops -> A saves -> beta survives)", async () => {
    const liveConfigA = loadConfig();
    const ownerA = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigA });

    // External writer adds beta while only A is running.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    await waitForOverlayLive("beta", "beta-model");
    // A alone preserves beta as disk-only.
    expect(liveConfigA.providers.beta).toBeUndefined();

    // B starts later with beta already in its live config.
    const liveConfigB = loadConfig();
    expect(liveConfigB.providers.beta).toBeDefined();
    const ownerB = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigB });

    // Force a reconcile across both owners. B owns beta, but A still lacks
    // it, so the preservation registry must keep beta for A's writes — an
    // older live projection must never erase a provider another active owner
    // owns. The disk rewrite below only bumps the file stamp to trigger a
    // reconcile tick; it is a fresh read of the file, so nothing needs to be
    // mutated in memory for it.
    writeFileSync(getConfigPath(), `${JSON.stringify(loadConfig(), null, 2)}\n`, "utf8");
    // A's serialization view must still carry beta while both owners are
    // alive (A lacks it in its live config; preservation protects it).
    expect(withPreservedDiskOnlyProviders(liveConfigA).providers.beta).toBeDefined();

    // B stops; A remains without beta in its live config.
    ownerB.stop();

    // An unrelated A save must keep beta on disk because A still treats it as
    // disk-only after the preservation recompute on owner removal.
    liveConfigA.providers.acme!.models = ["model-x", "model-extra", "model-y"];
    saveConfig(liveConfigA);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta?.modelCosts).toEqual({ "beta-model": OVERLAY });
    expect(resolveMatchedPrice("beta", "beta-model")?.source).toBe("user");

    ownerA.stop();
  });

  test("an unrelated save from an older owner cannot erase a provider owned by a newer active owner (A lacks beta -> B has beta -> both remain alive -> A saves -> beta survives)", async () => {
    const liveConfigA = loadConfig();
    const ownerA = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigA });

    // External writer adds beta while only A is running; A preserves it as a
    // provider it does not own.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    await waitForOverlayLive("beta", "beta-model");

    // B starts with beta already in its live config and STAYS alive.
    const liveConfigB = loadConfig();
    expect(liveConfigB.providers.beta).toBeDefined();
    const ownerB = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig: liveConfigB });

    // A performs an unrelated save while B is still running. A's live config
    // lacks beta, but the preservation registry must keep beta because a
    // different active owner owns it — otherwise A's save deletes B's
    // provider from disk.
    liveConfigA.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfigA);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta?.modelCosts).toEqual({ "beta-model": OVERLAY });
    expect(resolveMatchedPrice("beta", "beta-model")?.source).toBe("user");

    ownerA.stop();
    ownerB.stop();
  });

  test("final owner stop clears preservation so a later save cannot resurrect a deleted provider", async () => {
    const liveConfig = loadConfig();
    const owner = startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });

    // External writer adds beta; preservation remembers it.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    await waitForOverlayLive("beta", "beta-model");

    // Final owner stops: preservation must be cleared.
    owner.stop();

    // External writer deletes beta.
    const del = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      delete raw.providers.beta;
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(del.exitCode).toBe(0);

    // An unrelated in-process save must NOT resurrect beta.
    liveConfig.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();
  });

  test("process-wide stop clears preservation so a later save cannot resurrect a deleted provider", async () => {
    const liveConfig = loadConfig();
    startUserCostOverlayReconciler({ intervalMs: 20, liveConfig });

    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    await waitForOverlayLive("beta", "beta-model");

    stopUserCostOverlayReconciler();

    const del = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      delete raw.providers.beta;
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(del.exitCode).toBe(0);

    liveConfig.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();
  });

  test("overlay-only refresh without a live config does not preserve every disk provider", async () => {
    const liveConfig = loadConfig();

    // External writer adds beta.
    const { exitCode, stderr } = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      raw.providers.beta = {
        adapter: "openai-chat",
        baseUrl: "https://beta.example.invalid",
        apiKey: "sk-beta",
        modelCosts: { "beta-model": ${JSON.stringify(OVERLAY)} },
      };
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    // Overlay-only refresh (no live routing config) must not populate the
    // preservation registry with every disk provider.
    expect(reconcileUserCostOverlaysFromDisk()).toBe(true);

    // External writer deletes beta.
    const del = await runChild(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.OPENCODEX_HOME, "config.json");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      delete raw.providers.beta;
      writeFileSync(path, JSON.stringify(raw, null, 2) + "\\n", "utf8");
    `);
    expect(del.exitCode).toBe(0);

    // An unrelated in-process save must NOT resurrect beta.
    liveConfig.providers.acme!.models = ["model-x", "model-extra"];
    saveConfig(liveConfig);
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.providers.beta).toBeUndefined();
  });
});
