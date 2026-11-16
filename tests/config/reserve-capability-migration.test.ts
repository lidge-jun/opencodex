import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, getConfigPath, loadConfig, mutatePersistedConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import {
  isCodexReserveEnabled,
  migrateReserveCapability,
  projectReserveCapabilityMigration,
  RESERVE_CAPABILITY_MIGRATION_VERSION,
} from "../../src/config/reserve-capability";
import { migrateStartupReserveCapability } from "../../src/server/reserve-capability-startup";
import {
  isCodexReserveOptInMissing,
  isCodexReserveRequestEligible,
  isEffectiveCodexReserve,
} from "../../src/codex/loopback-target";
import { createReserveCatalogProjection } from "../../src/codex/catalog/reserve";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const MIGRATED = RESERVE_CAPABILITY_MIGRATION_VERSION;
const loopback = { source: "loopback" } as const;
const luna = { slug: "gpt-5.6-luna", display_name: "Luna" } as Record<string, unknown>;

let testDir = "";
const previousHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-reserve-capability-"));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

function baseConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-test", defaultModel: "gpt-test" } },
    ...extra,
  } as OcxConfig;
}

function writeConfigFile(value: unknown): void {
  writeFileSync(getConfigPath(), JSON.stringify(value), "utf-8");
}

function readConfigFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
}

describe("Reserve capability is independent of codexDesktopAuthless", () => {
  test.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("authless=%p reserve=%p: catalog and request eligibility follow reserve only", (authless, reserve) => {
    const config = baseConfig({ codexDesktopAuthless: authless, codexReserveEnabled: reserve, codexReserveMigration: MIGRATED });
    expect(isCodexReserveEnabled(config)).toBe(reserve);
    expect(isEffectiveCodexReserve(config)).toBe(reserve);
    expect(isCodexReserveRequestEligible(config, loopback)).toBe(reserve);
    expect(isCodexReserveOptInMissing(config, "gpt-reserve", loopback)).toBe(!reserve);
    expect(createReserveCatalogProjection(config, ["main"], null, luna) !== undefined).toBe(reserve);
  });

  test("role and listener admission still gate an enabled capability", () => {
    const config = baseConfig({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });
    expect(isCodexReserveRequestEligible({ ...config, runtimeRole: "client" }, loopback)).toBe(false);
    expect(isCodexReserveRequestEligible(config, { source: "bearer" })).toBe(false);
    expect(isCodexReserveRequestEligible(config, undefined)).toBe(false);
    expect(isEffectiveCodexReserve({ ...config, hostname: "0.0.0.0" })).toBe(false);
  });

  test.each([
    [true, true], [false, false], [undefined, false],
  ])("an unmigrated config with authless=%p reads Reserve as %p until it is seeded", (authless, expected) => {
    const config = baseConfig(authless === undefined ? {} : { codexDesktopAuthless: authless });
    expect(isCodexReserveEnabled(config)).toBe(expected);
    expect(migrateReserveCapability(config)).toBe(true);
    expect(config.codexReserveEnabled).toBe(expected);
    expect(config.codexReserveMigration).toBe(MIGRATED);
    expect(migrateReserveCapability(config)).toBe(false);
  });

  test("an explicit value survives the seed, and an absent value after the marker means off", () => {
    const explicit = baseConfig({ codexDesktopAuthless: true, codexReserveEnabled: false });
    migrateReserveCapability(explicit);
    expect(explicit.codexReserveEnabled).toBe(false);
    const deleted = baseConfig({ codexDesktopAuthless: true, codexReserveMigration: MIGRATED });
    expect(isCodexReserveEnabled(deleted)).toBe(false);
  });
});

describe("projectReserveCapabilityMigration", () => {
  test("seeds from the persisted document, not from an authless change in the same write", () => {
    const persisted = { codexDesktopAuthless: true };
    const candidate = baseConfig();
    const projected = projectReserveCapabilityMigration(persisted, candidate);
    expect(projected.codexReserveEnabled).toBe(true);
    expect(projected.codexReserveMigration).toBe(MIGRATED);
    const enabledNow = projectReserveCapabilityMigration({}, baseConfig({ codexDesktopAuthless: true }));
    expect(enabledNow.codexReserveEnabled).toBe(false);
  });

  test("a new config starts disabled", () => {
    const fresh = projectReserveCapabilityMigration(undefined, baseConfig());
    expect(isCodexReserveEnabled(fresh)).toBe(false);
    expect(Object.hasOwn(fresh, "codexReserveEnabled")).toBe(false);
    // A new document that sets authless keeps the legacy reading until startup records its seed.
    const withAuthless = baseConfig({ codexDesktopAuthless: true });
    expect(projectReserveCapabilityMigration(undefined, withAuthless)).toBe(withAuthless);
  });

  test("a write that leaves authless alone records nothing on an unmarked document", () => {
    for (const authless of [true, false, undefined]) {
      const persisted = authless === undefined ? {} : { codexDesktopAuthless: authless };
      const candidate = baseConfig(authless === undefined ? { port: 20200 } : { codexDesktopAuthless: authless, port: 20200 });
      expect(projectReserveCapabilityMigration(persisted, candidate)).toBe(candidate);
    }
    const explicit = projectReserveCapabilityMigration({ codexDesktopAuthless: true }, baseConfig({ codexDesktopAuthless: true, codexReserveEnabled: false }));
    expect(explicit).toMatchObject({ codexReserveEnabled: false, codexReserveMigration: MIGRATED });
  });

  test("a stale unmigrated snapshot carries the persisted capability instead of reseeding", () => {
    const persisted = { codexReserveEnabled: false, codexReserveMigration: MIGRATED, codexDesktopAuthless: true };
    const projected = projectReserveCapabilityMigration(persisted, baseConfig({ codexDesktopAuthless: true }));
    expect(projected.codexReserveEnabled).toBe(false);
    expect(projected.codexReserveMigration).toBe(MIGRATED);
  });

  test("a migrated candidate is authoritative, including a deleted value", () => {
    const candidate = baseConfig({ codexReserveMigration: MIGRATED });
    const projected = projectReserveCapabilityMigration({ codexReserveEnabled: true, codexReserveMigration: MIGRATED }, candidate);
    expect(Object.hasOwn(projected, "codexReserveEnabled")).toBe(false);
    expect(isCodexReserveEnabled(projected)).toBe(false);
  });

  test("projection is idempotent", () => {
    const once = projectReserveCapabilityMigration({ codexDesktopAuthless: true }, baseConfig());
    expect(projectReserveCapabilityMigration(once, once)).toEqual(once);
  });
});

describe("persisted writers carry the one-time migration", () => {
  test("saveConfig seeds from disk before an authless change, and later authless flips leave Reserve alone", () => {
    writeConfigFile(baseConfig({ codexDesktopAuthless: true }));
    const config = loadConfig();
    expect(isCodexReserveEnabled(config)).toBe(true);
    delete config.codexDesktopAuthless;
    saveConfig(config);
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });
    expect(isCodexReserveEnabled(loadConfig())).toBe(true);

    const again = loadConfig();
    again.codexDesktopAuthless = true;
    again.codexReserveEnabled = false;
    saveConfig(again);
    const reloaded = loadConfig();
    reloaded.codexDesktopAuthless = false;
    saveConfig(reloaded);
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: false, codexReserveMigration: MIGRATED });
  });

  test("deleting codexReserveEnabled from a migrated file does not restore inheritance", () => {
    writeConfigFile(baseConfig({ codexDesktopAuthless: true, codexReserveMigration: MIGRATED }));
    expect(isCodexReserveEnabled(loadConfig())).toBe(false);
  });

  test("mutatePersistedConfig seeds from disk", () => {
    writeConfigFile(baseConfig({ codexDesktopAuthless: true }));
    const outcome = mutatePersistedConfig(fresh => {
      delete fresh.codexDesktopAuthless;
      return { changed: true, value: undefined };
    });
    expect(outcome.status).toBe("committed");
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });
  });

  test("startup persists the seed once and keeps an explicit false", () => {
    writeConfigFile(baseConfig({ codexDesktopAuthless: true }));
    const loaded = loadConfig();
    const migrated = migrateStartupReserveCapability(loaded);
    // In place: the loaded object's identity carries file-backed provenance.
    expect(migrated).toBe(loaded);
    expect(migrated.codexReserveEnabled).toBe(true);
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });
    const before = readFileSync(getConfigPath(), "utf-8");
    migrateStartupReserveCapability(loadConfig());
    expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);

    writeConfigFile(baseConfig({ codexDesktopAuthless: false }));
    migrateStartupReserveCapability(loadConfig());
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: false, codexReserveMigration: MIGRATED });

    // A file that never set authless is left byte-for-byte alone and reads Reserve as off.
    writeConfigFile(baseConfig());
    const untouched = readFileSync(getConfigPath(), "utf-8");
    expect(isCodexReserveEnabled(migrateStartupReserveCapability(loadConfig()))).toBe(false);
    expect(readFileSync(getConfigPath(), "utf-8")).toBe(untouched);
  });

  test("the live writer keeps another process's Reserve change instead of reapplying a stale value", () => {
    writeConfigFile(baseConfig({ codexReserveEnabled: true, codexReserveMigration: MIGRATED }));
    const live = loadConfig();
    armClaudeCodeBaseline(live);
    const other = loadConfig();
    other.codexReserveEnabled = false;
    saveConfig(other);
    live.oauthOpenBrowser = false;
    saveConfigPreservingClaudeCode(live);
    expect(readConfigFile()).toMatchObject({ codexReserveEnabled: false, codexReserveMigration: MIGRATED, oauthOpenBrowser: false });
    expect(isCodexReserveEnabled(live)).toBe(false);
  });

  test("a failed startup publication stays visible and leaves the legacy reading in place", () => {
    const config = baseConfig({ codexDesktopAuthless: true });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const result = migrateStartupReserveCapability(config, () => { throw new Error("disk full"); });
      expect(result).toBe(config);
      expect(isCodexReserveEnabled(result)).toBe(true);
      expect(warnings.some(line => line.includes("reserve-capability-migration"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });
});

describe("/api/settings exposes codexReserveEnabled", () => {
  const deps = (saved: OcxConfig[], convergences: { count: number }): ManagementApiDeps => ({
    getCachedStartupHealth: async () => startupHealthFixture(),
    saveConfigPreservingClaudeCode: next => { saved.push(structuredClone(next)); },
    createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences.count += 1; }),
  });
  function request(method: "GET" | "PUT", body?: unknown): Request {
    return new Request("http://127.0.0.1:10100/api/settings", {
      method,
      headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("turning authless off keeps the seeded Reserve, and Reserve toggles persist explicitly", async () => {
    const config = baseConfig({ codexDesktopAuthless: true });
    const saved: OcxConfig[] = [];
    const convergences = { count: 0 };
    const read = await handleManagementAPI(request("GET"), new URL("http://127.0.0.1:10100/api/settings"), config, deps(saved, convergences));
    expect(await read!.json()).toMatchObject({ codexReserveEnabled: true, codexDesktopAuthless: true });

    const authlessOff = await handleManagementAPI(request("PUT", { codexDesktopAuthless: false }), new URL("http://127.0.0.1:10100/api/settings"), config, deps(saved, convergences));
    expect(authlessOff!.status).toBe(200);
    expect(await authlessOff!.json()).toMatchObject({ codexReserveEnabled: true, codexDesktopAuthless: false });
    expect(saved.at(-1)).toMatchObject({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });

    const reserveOff = await handleManagementAPI(request("PUT", { codexReserveEnabled: false }), new URL("http://127.0.0.1:10100/api/settings"), config, deps(saved, convergences));
    expect(reserveOff!.status).toBe(200);
    expect(await reserveOff!.json()).toMatchObject({ codexReserveEnabled: false });
    expect(saved.at(-1)!.codexReserveEnabled).toBe(false);
    const convergedAfterReserve = convergences.count;

    const authlessOn = await handleManagementAPI(request("PUT", { codexDesktopAuthless: true }), new URL("http://127.0.0.1:10100/api/settings"), config, deps(saved, convergences));
    expect(await authlessOn!.json()).toMatchObject({ codexReserveEnabled: false, codexDesktopAuthless: true });
    expect(convergedAfterReserve).toBeGreaterThan(0);

    const bad = await handleManagementAPI(request("PUT", { codexReserveEnabled: "yes" }), new URL("http://127.0.0.1:10100/api/settings"), config, deps(saved, convergences));
    expect(bad!.status).toBe(400);
  });

  test("the real writer persists the seed when only authless changes", async () => {
    writeConfigFile(baseConfig({ codexDesktopAuthless: true }));
    const config = loadConfig();
    armClaudeCodeBaseline(config);
    const response = await handleManagementAPI(request("PUT", { codexDesktopAuthless: false }), new URL("http://127.0.0.1:10100/api/settings"), config, {
      getCachedStartupHealth: async () => startupHealthFixture(),
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    });
    expect(response!.status).toBe(200);
    const persisted = readConfigFile();
    expect(persisted).toMatchObject({ codexReserveEnabled: true, codexReserveMigration: MIGRATED });
    expect(Object.hasOwn(persisted, "codexDesktopAuthless")).toBe(false);
  });

  test.each([
    ["before publication", () => new Error("disk full"), false],
    ["after publication", () => new ConfigWritePublishedError(new Error("bookkeeping")), true],
  ] as const)("a save that fails %s leaves live Reserve matching disk", async (_label, failure, published) => {
    const config = baseConfig({ codexReserveEnabled: false, codexReserveMigration: MIGRATED });
    const outcome = await handleManagementAPI(request("PUT", { codexReserveEnabled: true }), new URL("http://127.0.0.1:10100/api/settings"), config, {
      getCachedStartupHealth: async () => startupHealthFixture(),
      saveConfigPreservingClaudeCode: () => { throw failure(); },
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    }).then(response => response?.status ?? "no response", () => "threw");
    expect(outcome).not.toBe(200);
    expect(config.codexReserveEnabled).toBe(published);
  });

  test("after a published save fails before adoption, live Reserve follows the published file", async () => {
    // An unmarked live object still inherits authless; another process has migrated and disabled Reserve.
    writeConfigFile(baseConfig({ codexDesktopAuthless: true, codexReserveEnabled: false, codexReserveMigration: MIGRATED }));
    const config = baseConfig({ codexDesktopAuthless: true });
    const outcome = await handleManagementAPI(request("PUT", { codexDesktopAuthless: false }), new URL("http://127.0.0.1:10100/api/settings"), config, {
      getCachedStartupHealth: async () => startupHealthFixture(),
      saveConfigPreservingClaudeCode: () => {
        writeConfigFile(baseConfig({ codexReserveEnabled: false, codexReserveMigration: MIGRATED }));
        throw new ConfigWritePublishedError(new Error("bookkeeping"));
      },
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    }).then(response => response?.status ?? "no response", () => "threw");
    expect(outcome).not.toBe(200);
    expect(config.codexReserveEnabled).toBe(false);
    expect(config.codexReserveMigration).toBe(MIGRATED);
    expect(isCodexReserveEnabled(config)).toBe(false);
  });
});
