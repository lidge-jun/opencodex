import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../src/clients/config-export";
import { claudeDesktopIntegrationEnabled, grokIntegrationEnabled } from "../src/codex/desired-state";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";
import { IntegrationMutationBusyError, runIntegrationMutationFlight } from "../src/integrations/mutation-flight";
import { refreshOwnedIntegration } from "../src/integrations/owned-refresh";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import type { IntegrationWriterLockSeams } from "../src/integrations/writer-lock";
import { applyIntegration, disableIntegrationCoordinated } from "../src/integrations/writer";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * `ocx sync` used to write the Codex catalog and stop, so a Grok fence or a Desktop profile
 * kept whatever context windows it was created with until the next `ocx start`. That gap is
 * how a catalog change (1,050,000 -> 922,000) reached Codex and nothing else.
 *
 * These pin the gate the fan-out asks and the ordering the route depends on.
 */
describe("ocx sync fans out to enabled native clients and owned file integrations", () => {
  const base = { port: 10100, defaultProvider: "x", providers: {} } as OcxConfig;

  test("an absent toggle means ON — that is the shipped default, not an opt-in", () => {
    expect(grokIntegrationEnabled(base)).toBe(true);
    expect(claudeDesktopIntegrationEnabled(base)).toBe(true);
  });

  test("an explicit false is the only thing that takes a client out of the fan-out", () => {
    const grokOff = { ...base, clientIntegrations: { grok: false } } as OcxConfig;
    expect(grokIntegrationEnabled(grokOff)).toBe(false);
    // Turning one client off must not take the other with it.
    expect(claudeDesktopIntegrationEnabled(grokOff)).toBe(true);

    const desktopOff = { ...base, clientIntegrations: { "claude-desktop": false } } as OcxConfig;
    expect(claudeDesktopIntegrationEnabled(desktopOff)).toBe(false);
    expect(grokIntegrationEnabled(desktopOff)).toBe(true);
  });

  test("Codex runs before the clients that read its catalog, and a refused sync stops the fan-out", async () => {
    const src = await Bun.file(new URL("../src/server/management/config-routes.ts", import.meta.url)).text();
    const routeStart = src.indexOf('url.pathname === "/api/sync"');
    expect(routeStart).toBeGreaterThan(-1);
    const route = src.slice(routeStart, routeStart + 1400);

    // Ordering is load-bearing: Grok and Desktop both read the catalog Codex writes.
    expect(route.indexOf("syncModelsToCodex")).toBeLessThan(route.indexOf("syncEnabledClientIntegrations"));
    // A refused Codex sync wrote no catalog, so there is nothing new for a client to read.
    expect(route).toContain('result.status === "refused"');
  });

  test("each client is gated on its own toggle and its failure stays non-fatal", async () => {
    const src = await Bun.file(new URL("../src/server/management/config-routes.ts", import.meta.url)).text();
    const start = src.indexOf("async function syncEnabledClientIntegrations");
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf("\nfunction publicVisionSidecarSettings", start));

    expect(fn).toContain("grokIntegrationEnabled(config)");
    expect(fn).toContain("claudeDesktopIntegrationEnabled(config)");
    expect(fn).toContain('clientId: "mcode"');
    expect(fn).toContain("refreshOwnedIntegration");
    // One catch per client: a broken client file is a warning, not a 500 on a command whose
    // main job (the Codex catalog) succeeded.
    expect(fn.match(/catch \(error\)/g)?.length).toBe(3);
    // The Desktop write gets the native context limits, same as every other Desktop
    // call site. 8b672205e threaded `nativeContextLimits` through those writers and
    // left this assertion naming the retired `providerContextCap` spelling, so the
    // source-shape check failed against the very change it is meant to pin.
    expect(fn).toContain("nativeContextLimits(config)");
    // A client that is off is omitted rather than reported: the caller has to be able to
    // tell "left alone" from "tried and failed", so there is no skipped state to emit.
    expect(fn).not.toContain('"skipped"');
  });
});

describe("ocx sync refreshes an already-owned MCode integration", () => {
  const env = {} as NodeJS.ProcessEnv;
  const config = {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as OcxConfig;
  const oldModels: ExportModel[] = [{
    namespaced: "openai/gpt-5.6-sol",
    provider: "openai",
    id: "gpt-5.6-sol",
    contextWindow: 272_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  }];
  const newModels: ExportModel[] = [{
    namespaced: "openai/gpt-5.6-sol",
    provider: "openai",
    id: "gpt-5.6-sol",
    contextWindow: 922_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  }];

  let root: string;
  let home: string;
  let store: IntegrationStateStore;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-mcode-auto-sync-"));
    home = join(root, "home");
    store = createIntegrationStateStore(join(root, "state", "integrations"));
    const spec = INTEGRATION_CLIENTS.mcode;
    mkdirSync(spec.detectDir(env, home), { recursive: true });
    configPath = spec.configPath(env, home);
    mkdirSync(dirname(configPath), { recursive: true });
  });

  afterEach(() => {
    removeTreeWithRetry(root);
  });

  function input(models: readonly ExportModel[] | (() => Promise<readonly ExportModel[]>)) {
    return { clientId: "mcode" as const, models, config, port: 10100, env, home, store };
  }

  test("updates context and the full max/ultra effort ladder through the real writer", async () => {
    writeFileSync(configPath, "theme: dark\n");
    const applied = applyIntegration(input(oldModels));
    expect(applied.ok).toBe(true);

    const refreshed = await refreshOwnedIntegration(input(newModels));
    expect(refreshed).toEqual({ client: "mcode", ok: true, changed: true });

    const document = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      custom_provider: { opencodex: { models: Record<string, unknown> } };
    };
    expect(document.custom_provider.opencodex.models["openai/gpt-5.6-sol"]).toEqual({
      limit: { context: 922_000 },
      thinking: { effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    });
    expect(document).toMatchObject({ theme: "dark" });
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["refresh", "apply"]);
  });

  test("does nothing and never loads the catalog when no ownership record exists", async () => {
    const before = [
      "custom_provider:",
      "  opencodex:",
      "    name: User-owned OpenCodex block",
      "    models: {}",
      "",
    ].join("\n");
    writeFileSync(configPath, before);

    let catalogLoads = 0;
    expect(await refreshOwnedIntegration(input(async () => {
      catalogLoads += 1;
      return newModels;
    }))).toBeNull();
    expect(catalogLoads).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(store.listOperations("mcode")).toHaveLength(0);
  });

  test("refuses a foreign edit without changing bytes or appending a journal row", async () => {
    expect(applyIntegration(input(oldModels)).ok).toBe(true);
    const recordBefore = JSON.stringify(store.readRecords().mcode);
    const edited = readFileSync(configPath, "utf8").replace("context: 272000", "context: 123456");
    expect(edited).not.toBe(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, edited);

    const outcome = await refreshOwnedIntegration(input(newModels));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toContain("changed after opencodex wrote it");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(JSON.stringify(store.readRecords().mcode)).toBe(recordBefore);
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);
  });

  test("refuses whole-file YAML drift even when the owned block itself is intact", async () => {
    expect(applyIntegration(input(oldModels)).ok).toBe(true);
    const recordBefore = JSON.stringify(store.readRecords().mcode);
    const edited = `# user comment\n${readFileSync(configPath, "utf8")}`;
    writeFileSync(configPath, edited);

    const outcome = await refreshOwnedIntegration(input(newModels));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toContain("changed after opencodex wrote it");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(JSON.stringify(store.readRecords().mcode)).toBe(recordBefore);
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);
  });

  test("does not recreate a managed block the user removed", async () => {
    expect(applyIntegration(input(oldModels)).ok).toBe(true);
    writeFileSync(configPath, "theme: dark\n");

    const outcome = await refreshOwnedIntegration(input(newModels));
    expect(outcome).toEqual({
      client: "mcode",
      ok: true,
      changed: false,
      reason: "managed block is absent; refresh did not reconnect it",
    });
    expect(readFileSync(configPath, "utf8")).toBe("theme: dark\n");
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);
  });

  test("is a no-op when the owned block already matches the catalog", async () => {
    expect(applyIntegration(input(newModels)).ok).toBe(true);

    expect(await refreshOwnedIntegration(input(newModels)))
      .toEqual({ client: "mcode", ok: true, changed: false });
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);
  });

  test("does not recreate the client home or config when MCode was removed", async () => {
    expect(applyIntegration(input(oldModels)).ok).toBe(true);
    removeTreeWithRetry(INTEGRATION_CLIENTS.mcode.detectDir(env, home));

    const outcome = await refreshOwnedIntegration(input(newModels));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.reason).toContain("mcode is not installed");
    expect(existsSync(INTEGRATION_CLIENTS.mcode.detectDir(env, home))).toBe(false);
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);
  });

  test("serializes a CLI refresh racing a server disable across the process boundary", async () => {
    expect(applyIntegration(input(oldModels)).ok).toBe(true);
    const before = readFileSync(configPath, "utf8");
    const recordBefore = JSON.stringify(store.readRecords().mcode);

    let held = false;
    let acquisitions = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let observeFirst!: () => void;
    let observeSecond!: () => void;
    let observeWaiter!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const firstAcquired = new Promise<void>(resolve => { observeFirst = resolve; });
    const secondAcquired = new Promise<void>(resolve => { observeSecond = resolve; });
    const waiterBlocked = new Promise<void>(resolve => { observeWaiter = resolve; });
    const released: Array<() => void> = [];
    const lockSeams: IntegrationWriterLockSeams = {
      writeFile: async () => {
        if (held) throw Object.assign(new Error("contended"), { code: "EEXIST" });
        held = true;
        acquisitions += 1;
        if (acquisitions === 1) {
          observeFirst();
          await firstGate;
        } else if (acquisitions === 2) {
          observeSecond();
          await secondGate;
        }
      },
      removeFile: async () => {
        held = false;
        for (const release of released.splice(0)) release();
      },
      now: () => 0,
      delay: async () => {
        observeWaiter();
        await new Promise<void>(resolve => { released.push(resolve); });
      },
      pid: 22,
    };

    // These calls model separate processes: owned refresh has the CLI's in-memory
    // flight map, while the direct coordinated disable has the server's map.
    const refresh = refreshOwnedIntegration(input(newModels), { lockSeams });
    await firstAcquired;
    const disable = disableIntegrationCoordinated(input(newModels), { lockSeams });
    await waiterBlocked;

    // The contender cannot observe or create a half-committed transaction.
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(JSON.stringify(store.readRecords().mcode)).toBe(recordBefore);
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["apply"]);

    releaseFirst();
    await secondAcquired;
    expect(await refresh).toEqual({ client: "mcode", ok: true, changed: true });
    const refreshed = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      custom_provider: { opencodex: { models: Record<string, unknown> } };
    };
    expect(refreshed.custom_provider.opencodex.models["openai/gpt-5.6-sol"]).toEqual({
      limit: { context: 922_000 },
      thinking: { effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    });
    expect(store.readRecords().mcode).toBeDefined();
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["refresh", "apply"]);

    releaseSecond();
    expect((await disable).ok).toBe(true);
    expect(store.readRecords().mcode).toBeUndefined();
    expect(store.listOperations("mcode").map(row => row.kind)).toEqual(["disable", "refresh", "apply"]);
    const finalDocument = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      custom_provider?: { opencodex?: unknown };
    };
    expect(finalDocument.custom_provider?.opencodex).toBeUndefined();
  });
});

test("the direct ocx sync command refreshes MCode instead of relying on /api/sync", async () => {
  const src = await Bun.file(new URL("../src/cli/dispatch.ts", import.meta.url)).text();
  const start = src.indexOf("sync: async deps =>");
  const command = src.slice(start, src.indexOf("v2: async deps =>", start));
  expect(command).toContain("refreshOwnedIntegration");
  expect(command).toContain('clientId: "mcode"');
  expect(command.indexOf("syncModelsToCodex")).toBeLessThan(command.indexOf("refreshOwnedIntegration"));
  expect(command).toContain('synced.status !== "refused"');
});

test("refresh joins refresh but cannot swallow an explicit apply or disable", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let refreshRuns = 0;
  const first = runIntegrationMutationFlight("mcode", "refresh", () => 1_000, async () => {
    refreshRuns += 1;
    await gate;
    return "refreshed";
  });
  const joined = runIntegrationMutationFlight("mcode", "refresh", () => 1_001, async () => {
    refreshRuns += 1;
    return "should-not-run";
  });

  await expect(runIntegrationMutationFlight("mcode", "apply", () => 1_002, async () => "applied"))
    .rejects.toBeInstanceOf(IntegrationMutationBusyError);
  await expect(runIntegrationMutationFlight("mcode", "disable", () => 1_003, async () => "disabled"))
    .rejects.toBeInstanceOf(IntegrationMutationBusyError);

  release();
  expect(await first).toBe("refreshed");
  expect(await joined).toBe("refreshed");
  expect(refreshRuns).toBe(1);
});
