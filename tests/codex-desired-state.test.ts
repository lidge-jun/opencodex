/**
 * Durable desired state for the native Codex integration.
 *
 * The switch was never the hard part — `ocx restore` already unroutes Codex
 * without stopping the proxy. What was missing is that the decision did not
 * survive a restart, because `ocx start` force-synced unconditionally. These
 * tests pin the two halves of the fix: absence means ON, and only an explicit
 * `false` gates the startup sync.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, saveConfig } from "../src/config";
import {
  codexIntegrationEnabled,
  codexIntegrationEnabledNow,
  setCodexIntegrationEnabled,
  setGrokIntegrationEnabled,
  grokIntegrationEnabled,
  shouldSyncCodexOnStart,
  shouldSyncGrokOnStart,
  syncCodexOnStartIfEnabled,
} from "../src/codex/desired-state";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let testRoot = "";
let previousOpencodexHome: string | undefined;

function baseConfig(): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai" };
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(tmpdir(), "ocx-desired-state-"));
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

describe("absence means ON", () => {
  /**
   * Three different configs, one meaning. A user who never touched a switch, a
   * config written by a binary that predates this field, and an explicit `true`
   * are the same state — and none of them may read as "turned off". Only an
   * explicit `false` is OFF.
   */
  const onCases: { name: string; config: OcxConfig }[] = [
    { name: "no clientIntegrations at all", config: baseConfig() },
    { name: "an empty clientIntegrations object", config: { ...baseConfig(), clientIntegrations: {} } },
    { name: "an explicit true", config: { ...baseConfig(), clientIntegrations: { codex: true } } },
  ];

  for (const { name, config } of onCases) {
    test(`${name} reads as enabled`, () => {
      expect(codexIntegrationEnabled(config)).toBe(true);
    });
  }

  test("only an explicit false is off", () => {
    expect(codexIntegrationEnabled({ ...baseConfig(), clientIntegrations: { codex: false } })).toBe(false);
  });

  /**
   * A hand edit of the wrong type must not be read as OFF. `"false"` is a string,
   * and treating any non-true value as OFF would silently unroute a user who
   * fat-fingered their config — the schema drops the bad key, and absence is ON.
   */
  test("a malformed value degrades to ON rather than OFF, and keeps unknown keys", () => {
    writeFileSync(
      join(testRoot, "config.json"),
      JSON.stringify({
        ...baseConfig(),
        clientIntegrations: { codex: "false", "future-client": false },
      }, null, 2),
    );
    const loaded = loadConfig();
    expect(codexIntegrationEnabled(loaded)).toBe(true);
    // The key this binary does not understand survives the parse.
    expect((loaded.clientIntegrations as Record<string, unknown> | undefined)?.["future-client"]).toBe(false);
  });
});

describe("persisting the decision", () => {
  test("turning it off is written, and survives a fresh read", () => {
    saveConfig(baseConfig());
    expect(codexIntegrationEnabledNow()).toBe(true);

    const result = setCodexIntegrationEnabled(false);
    expect(result).toMatchObject({ ok: true, status: "committed", enabled: false });
    expect(codexIntegrationEnabledNow()).toBe(false);

    // And it is on disk, not merely in a cache.
    const raw = JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>;
    expect((raw.clientIntegrations as Record<string, unknown>).codex).toBe(false);
  });

  /**
   * Re-enabling REMOVES the key rather than storing `true`. Otherwise an
   * untouched config and a re-enabled one differ in bytes while meaning the same
   * thing, and every later reader has to treat them identically anyway.
   */
  test("turning it back on removes the key instead of storing true", () => {
    saveConfig(baseConfig());
    setCodexIntegrationEnabled(false);
    expect(setCodexIntegrationEnabled(true)).toMatchObject({ ok: true, status: "committed", enabled: true });

    const raw = JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.clientIntegrations).toBeUndefined();
    expect(codexIntegrationEnabledNow()).toBe(true);
  });

  test("setting the state it is already in is unchanged, not a write", () => {
    saveConfig(baseConfig());
    expect(setCodexIntegrationEnabled(true)).toMatchObject({ ok: true, status: "unchanged" });
    setCodexIntegrationEnabled(false);
    expect(setCodexIntegrationEnabled(false)).toMatchObject({ ok: true, status: "unchanged" });
  });

  /**
   * The mutation is field-scoped. A whole-config write built from a stale read
   * would clobber a provider edit that landed in between; this asserts the
   * neighbouring field is still there afterwards.
   */
  test("writing the switch preserves unrelated config the caller never saw", () => {
    saveConfig({
      ...baseConfig(),
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      } as OcxConfig["providers"],
    });
    setCodexIntegrationEnabled(false);

    const after = loadConfig();
    expect(Object.keys(after.providers)).toEqual(["openai"]);
    expect(codexIntegrationEnabled(after)).toBe(false);
  });

  test("an unknown future key in the object is preserved across a write", () => {
    writeFileSync(
      join(testRoot, "config.json"),
      JSON.stringify({ ...baseConfig(), clientIntegrations: { "future-client": false } }, null, 2),
    );
    setCodexIntegrationEnabled(false);

    const raw = JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>;
    const integrations = raw.clientIntegrations as Record<string, unknown>;
    expect(integrations.codex).toBe(false);
    expect(integrations["future-client"]).toBe(false);
  });

  test("a missing config refuses rather than creating one", () => {
    const result = setCodexIntegrationEnabled(false);
    expect(result).toMatchObject({ ok: false, reason: "missing", retryable: false });
  });
});

describe("the startup gate", () => {
  /**
   * This is the defect the whole phase exists for. `ocx start` called
   * `syncModelsToCodex(port).catch(() => {})` unconditionally, so an OFF lasted
   * exactly until the next start: restore unrouted Codex, and start put the
   * routing straight back.
   *
   * It lived inline in a 600-line startup function that binds sockets and
   * installs services, which is why nothing tested it — and an untestable gate is
   * how the unconditional version survived. It is a function now.
   */
  test("an explicit OFF skips the startup sync entirely", async () => {
    let calls = 0;
    const ran = await syncCodexOnStartIfEnabled(
      10100,
      { clientIntegrations: { codex: false } },
      async () => { calls += 1; return undefined; },
    );
    expect(ran.ran).toBe(false);
    expect(calls).toBe(0);
  });

  test("the shared sync predicate has the same absent-means-on semantics", () => {
    expect(shouldSyncCodexOnStart(baseConfig())).toBe(true);
    expect(shouldSyncCodexOnStart({ ...baseConfig(), clientIntegrations: { codex: false } })).toBe(false);
  });

  test("the hub role never syncs its host's client configs on start", () => {
    // First clisu-oracle dogfood boot: runtimeRole=hub ran the full local client
    // sync, marked /readyz failed on provider-discovery noise, and rewrote
    // ~/.grok/config.toml on a machine that is a SERVER for other machines.
    expect(shouldSyncCodexOnStart({ ...baseConfig(), runtimeRole: "hub" })).toBe(false);
    expect(shouldSyncGrokOnStart({ ...baseConfig(), runtimeRole: "hub" })).toBe(false);
    // client/standalone roles keep today's behavior.
    expect(shouldSyncCodexOnStart({ ...baseConfig(), runtimeRole: "standalone" })).toBe(true);
    expect(shouldSyncGrokOnStart({ ...baseConfig(), runtimeRole: "standalone" })).toBe(true);
  });

  test("a hub with an unauthenticated loopback listener syncs only enabled local clients (#3306)", async () => {
    const hubClient = {
      ...baseConfig(),
      runtimeRole: "hub" as const,
      hostname: "100.64.0.10",
      unauthenticatedLoopbackListener: { enabled: true as const, port: 10102 },
    };

    expect(shouldSyncCodexOnStart(hubClient)).toBe(true);
    expect(shouldSyncGrokOnStart(hubClient)).toBe(true);
    expect(shouldSyncCodexOnStart({
      ...hubClient,
      clientIntegrations: { codex: false },
    })).toBe(false);
    expect(shouldSyncGrokOnStart({
      ...hubClient,
      clientIntegrations: { grok: false },
    })).toBe(false);

    let calls = 0;
    const result = await syncCodexOnStartIfEnabled(
      10100,
      hubClient,
      async () => { calls += 1; return undefined; },
    );
    expect(result.ran).toBe(true);
    expect(calls).toBe(1);
  });

  test("absence, an empty object, and an explicit true all still sync", async () => {
    for (const clientIntegrations of [undefined, {}, { codex: true }]) {
      let calls = 0;
      const ran = await syncCodexOnStartIfEnabled(
        10100,
        { clientIntegrations },
        async () => { calls += 1; return undefined; },
      );
      expect(ran.ran).toBe(true);
      expect(calls).toBe(1);
    }
  });

  test("the port reaches the sync", async () => {
    const ports: number[] = [];
    await syncCodexOnStartIfEnabled(43210, {}, async port => { ports.push(port); return undefined; });
    expect(ports).toEqual([43210]);
  });

  /**
   * The swallow stays, and is asserted rather than assumed. A provider fetch
   * failing at startup must not stop the proxy from coming up — swallowing a
   * failure to APPLY is tolerable, swallowing the user's DECISION was not.
   */
  test("a sync failure is swallowed so startup continues, and still reports that it ran", async () => {
    const ran = await syncCodexOnStartIfEnabled(
      10100,
      {},
      async () => { throw new Error("provider unreachable"); },
    );
    expect(ran.ran).toBe(true);
    // #1046: a failed sync reports no writes, so the caller does not warn.
    expect(ran.catalogWritten).toBe(false);
    expect(ran.cacheSynced).toBe(false);
  });
});

describe("Grok has the same durability, because it shipped without it", () => {
  /**
   * Grok's toggle already existed and already worked — and lasted exactly one
   * restart. It strips the fence from `~/.grok/config.toml` and recorded
   * nothing, so `ocx start` called `syncGrokConfig` unconditionally and wrote
   * the fence straight back. Identical defect to Codex, different file.
   */
  test("absence, empty, and explicit true all read as enabled; only false is off", () => {
    expect(grokIntegrationEnabled(baseConfig())).toBe(true);
    expect(grokIntegrationEnabled({ ...baseConfig(), clientIntegrations: {} })).toBe(true);
    expect(grokIntegrationEnabled({ ...baseConfig(), clientIntegrations: { grok: true } })).toBe(true);
    expect(grokIntegrationEnabled({ ...baseConfig(), clientIntegrations: { grok: false } })).toBe(false);
  });

  test("the startup sync is skipped only for an explicit off", () => {
    expect(shouldSyncGrokOnStart(baseConfig())).toBe(true);
    expect(shouldSyncGrokOnStart({ ...baseConfig(), clientIntegrations: { grok: true } })).toBe(true);
    expect(shouldSyncGrokOnStart({ ...baseConfig(), clientIntegrations: { grok: false } })).toBe(false);
  });

  /**
   * The two switches are independent. Turning Codex off must not take Grok with
   * it — a shared key or a shared helper reading the wrong field would, and the
   * ten-key union this design rejected is exactly how that happens.
   */
  test("the two clients do not affect each other", () => {
    saveConfig(baseConfig());
    setCodexIntegrationEnabled(false);

    const after = loadConfig();
    expect(codexIntegrationEnabled(after)).toBe(false);
    expect(grokIntegrationEnabled(after)).toBe(true);

    setGrokIntegrationEnabled(false);
    const both = loadConfig();
    expect(codexIntegrationEnabled(both)).toBe(false);
    expect(grokIntegrationEnabled(both)).toBe(false);

    // And re-enabling one leaves the other alone.
    setCodexIntegrationEnabled(true);
    const one = loadConfig();
    expect(codexIntegrationEnabled(one)).toBe(true);
    expect(grokIntegrationEnabled(one)).toBe(false);
  });

  test("the last client re-enabled removes the whole object, not an empty husk", () => {
    saveConfig(baseConfig());
    setCodexIntegrationEnabled(false);
    setGrokIntegrationEnabled(false);
    setCodexIntegrationEnabled(true);
    setGrokIntegrationEnabled(true);

    const raw = JSON.parse(readFileSync(join(testRoot, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.clientIntegrations).toBeUndefined();
  });
});
