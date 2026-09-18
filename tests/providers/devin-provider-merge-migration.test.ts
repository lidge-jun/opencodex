import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import {
  projectDevinProviderMerge,
  runDevinProviderMergeStartupMigration,
} from "../../src/providers/devin-provider-merge-migration";
import { loadAuthStore, rekeyProviderCredentials } from "../../src/oauth/store";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A config as written while `devin-cli` was still a registry id: the provider
 * row under the old key, plus one of every cross-config reference shape the
 * rewriter owns — routed strings, bare provider ids, and provider-keyed maps.
 */
function migratableConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "devin-cli",
    providers: {
      "devin-cli": { adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "oauth" },
    },
    disabledModels: ["devin-cli/swe-2", "anthropic/claude-sonnet-5"],
    customModels: [{ id: "mine", provider: "devin-cli", modelId: "swe-2" }],
    combos: { fast: { targets: [{ provider: "devin-cli", model: "swe-2" }] } },
    routingProfiles: {
      policy: { candidates: [{ provider: "devin-cli", model: "swe-2" }, { provider: "anthropic", model: "claude-sonnet-5" }] },
    },
    providerContextCaps: { "devin-cli": 262_000, anthropic: 200_000 },
  } as unknown as OcxConfig;
}

describe("devin provider merge projection", () => {
  test("moves the providers key and re-points every reference shape", () => {
    const p = projectDevinProviderMerge(migratableConfig());
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]).toBeUndefined();
    const moved = p.config.providers!["devin"]!;
    expect(moved.baseUrl).toBe("https://server.codeium.com");
    expect(p.config.defaultProvider).toBe("devin");
    expect(p.config.disabledModels).toEqual(["devin/swe-2", "anthropic/claude-sonnet-5"]);
    expect(p.config.customModels![0]!.provider).toBe("devin");
    expect(p.config.combos!.fast!.targets![0]!.provider).toBe("devin");
    expect(p.config.providerContextCaps).toEqual({ devin: 262_000, anthropic: 200_000 });
    expect(p.warnings.join(" ")).toContain('"devin-cli"');
  });

  test("re-points routingProfiles candidates, which the rewriter used to miss", () => {
    // candidates[].provider is a bare provider id validated against configured
    // providers (src/routing/profile.ts): left as "devin-cli" the profile would
    // name a provider that no longer exists.
    const p = projectDevinProviderMerge(migratableConfig());
    const candidates = p.config.routingProfiles!.policy!.candidates;
    expect(candidates.map(c => c.provider)).toEqual(["devin", "anthropic"]);
  });

  test("normalizes the moved row to the canonical entry's contract", () => {
    // Rows saved in the ACP era carry adapter "devin-cli", authMode "local",
    // and the cli.devin.ai identity URL — none of which the merged `devin`
    // registry entry admits. This is the authMode half of the old
    // projectDevinCliAuthMode pass, absorbed into the move.
    const config = migratableConfig();
    config.providers!["devin-cli"] = {
      adapter: "devin-cli",
      baseUrl: "https://cli.devin.ai",
      authMode: "local",
    } as never;
    const p = projectDevinProviderMerge(config);
    const moved = p.config.providers!["devin"]!;
    expect(moved.adapter).toBe("devin");
    expect(moved.authMode).toBe("oauth");
    expect(moved.baseUrl).toBe("https://server.codeium.com");
  });

  test("refuses when providers[\"devin\"] already exists", () => {
    // Both rows may belong to different accounts; picking a survivor is a user
    // decision, so the original config comes back untouched with a warning.
    const config = migratableConfig();
    config.providers!["devin"] = { adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "oauth" } as never;
    const before = structuredClone(config);
    const p = projectDevinProviderMerge(config);
    expect(p.changed).toBe(false);
    expect(p.config.providers!["devin-cli"]).toBeDefined();
    expect(p.config.providers!["devin"]).toBeDefined();
    expect(p.warnings.join(" ")).toContain('"devin" already exists');
    expect(config).toEqual(before);
  });

  test("refuses when a Codex account namespace reserves the destination", () => {
    const config = { ...migratableConfig(), codexAccountNamespaces: { devin: "pool-a" } } as unknown as OcxConfig;
    const p = projectDevinProviderMerge(config);
    expect(p.changed).toBe(false);
    expect(p.config.providers!["devin-cli"]).toBeDefined();
    expect(p.warnings.join(" ")).toContain("account namespace");
  });

  test("a reference collision refuses and returns the original config", () => {
    // The rewriter is not transactional: by the time it reports a collision
    // the clone is already partly rewritten, so the projection must return
    // the pre-rewrite input rather than the half-moved clone.
    const config = migratableConfig();
    config.providerContextCaps = { "devin-cli": 262_000, devin: 500_000 } as never;
    const p = projectDevinProviderMerge(config);
    expect(p.changed).toBe(false);
    expect(p.config).toBe(config);
    expect(p.config.providerContextCaps).toEqual({ "devin-cli": 262_000, devin: 500_000 });
    expect(p.warnings.join(" ")).toContain("providerContextCaps.devin");
  });

  test("is a no-op when devin-cli is not configured, and idempotent after moving", () => {
    const absent = projectDevinProviderMerge({ providers: {} } as unknown as OcxConfig);
    expect(absent.changed).toBe(false);
    expect(absent.warnings).toEqual([]);

    const once = projectDevinProviderMerge(migratableConfig());
    const twice = projectDevinProviderMerge(once.config);
    expect(twice.changed).toBe(false);
    expect(twice.config).toEqual(once.config);
  });
});

describe("devin provider merge startup runner", () => {
  function depsWith(order: string[], opts: { hasAuthSlot?: boolean; rekey?: () => Promise<"moved" | "absent" | "conflict"> } = {}) {
    return {
      project: projectDevinProviderMerge,
      backupConfig: () => { order.push("backupConfig"); },
      backupAuth: () => { order.push("backupAuth"); },
      save: () => { order.push("save"); },
      hasAuthSlot: () => opts.hasAuthSlot ?? false,
      rekey: async (from: string, to: string) => { order.push(`rekey:${from}->${to}`); return opts.rekey ? opts.rekey() : "moved" as const; },
    };
  }

  test("snapshots config strictly before saving, and rekeys the auth slot", async () => {
    const order: string[] = [];
    const result = runDevinProviderMergeStartupMigration(migratableConfig(), depsWith(order, { hasAuthSlot: true }));
    expect(order.slice(0, 2)).toEqual(["backupConfig", "save"]);
    expect(order).toContain("backupAuth");
    expect(order).toContain("rekey:devin-cli->devin");
    expect(result.providers!['devin']).toBeDefined();
    // The rekey is deliberately detached — startServer is synchronous — so its
    // promise settles after the return; give it a microtask turn to land.
    await Promise.resolve();
  });

  test("a no-op projection never backs up or saves, but a credential slot still rekeys", async () => {
    // The auth half runs even when the config half has nothing to do: a
    // devin-cli slot is orphaned state regardless of provider rows.
    const order: string[] = [];
    const config = { providers: {} } as unknown as OcxConfig;
    runDevinProviderMergeStartupMigration(config, depsWith(order, { hasAuthSlot: true }));
    expect(order).toEqual(["backupAuth", "rekey:devin-cli->devin"]);
    await Promise.resolve();
  });

  test("no credential slot means no auth backup and no rekey", () => {
    const order: string[] = [];
    runDevinProviderMergeStartupMigration(migratableConfig(), depsWith(order));
    expect(order).toEqual(["backupConfig", "save"]);
  });

  test("a config collision warns without backing up or saving", () => {
    const order: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const config = migratableConfig();
      config.providers!["devin"] = { adapter: "devin" } as never;
      runDevinProviderMergeStartupMigration(config, depsWith(order));
    } finally {
      console.warn = originalWarn;
    }
    expect(order).toEqual([]);
    expect(warnings.join(" ")).toContain("[devin-provider-merge]");
  });

  test("a rekey conflict warns rather than throwing out of startup", async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      runDevinProviderMergeStartupMigration(migratableConfig(), depsWith(order, { hasAuthSlot: true, rekey: async () => "conflict" }));
      // The detached promise needs a real tick, not one microtask.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join(" ")).toContain('auth.json already has a "devin" credential slot');
  });
});

// ---------------------------------------------------------------------------
// rekeyProviderCredentials against a real auth.json in a throwaway home.
// ---------------------------------------------------------------------------

describe("rekeyProviderCredentials", () => {
  const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-devin-rekey-"));
  let previousHome: string | undefined;

  const accountSet = (key: string) => ({
    activeAccountId: "acct-1",
    accounts: [{ id: "acct-1", credential: { access: key, refresh: key, expires: Number.MAX_SAFE_INTEGER } }],
  });

  const writeStore = (store: Record<string, unknown>) => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "auth.json"), JSON.stringify(store));
  };

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(async () => {
    await flushConfigDirHardeningForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
  });

  test("moves the devin-cli slot onto devin", async () => {
    writeStore({ "devin-cli": accountSet("cli-key"), anthropic: accountSet("other") });
    expect(await rekeyProviderCredentials("devin-cli", "devin")).toBe("moved");
    const store = loadAuthStore();
    expect(store["devin-cli"]).toBeUndefined();
    expect(store["devin"]!.accounts[0]!.credential.access).toBe("cli-key");
    expect(store["anthropic"]).toBeDefined();
  });

  test("an absent source slot is a no-op", async () => {
    writeStore({ anthropic: accountSet("other") });
    expect(await rekeyProviderCredentials("devin-cli", "devin")).toBe("absent");
    expect(loadAuthStore()["devin"]).toBeUndefined();
  });

  test("an occupied destination refuses and leaves both slots", async () => {
    // Two slots can be two different humans; the helper reports the conflict
    // instead of picking a survivor, matching the config-side refusal.
    writeStore({ "devin-cli": accountSet("cli-key"), devin: accountSet("devin-key") });
    expect(await rekeyProviderCredentials("devin-cli", "devin")).toBe("conflict");
    const store = loadAuthStore();
    expect(store["devin-cli"]!.accounts[0]!.credential.access).toBe("cli-key");
    expect(store["devin"]!.accounts[0]!.credential.access).toBe("devin-key");
  });

  test("a second run after a successful move is absent, not another move", async () => {
    writeStore({ "devin-cli": accountSet("cli-key") });
    expect(await rekeyProviderCredentials("devin-cli", "devin")).toBe("moved");
    expect(await rekeyProviderCredentials("devin-cli", "devin")).toBe("absent");
    expect(loadAuthStore()["devin"]!.accounts[0]!.credential.access).toBe("cli-key");
  });
});
