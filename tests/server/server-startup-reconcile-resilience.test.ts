/**
 * Startup reconciliation must never be able to kill boot (#3524).
 *
 * `startServer` is synchronous by design and calls `runModelRenameStartupMigration`
 * (src/server/index.ts:651) and `reconcileOAuthProviders` (:663) with no try/catch. Both
 * now rebase their write on the persisted config, and a persistence failure there is a
 * degrade-and-warn, not a throw: an operator whose config.json vanished, was hand-edited
 * into invalid JSON, or sits on an unreadable volume still gets a running proxy.
 *
 * RED against #3524's head, which threw "OAuth provider reconciliation persistence
 * unavailable: missing" from exactly this sequence. It is NOT red on unmodified dev — dev
 * never throws, it silently overwrites — so the defect itself is proven by the
 * concurrent-edit tests in tests/oauth/oauth-provider-reconcile.test.ts and
 * tests/providers/model-rename-migration.test.ts, not here.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import * as configStore from "../../src/config";
import * as stateStores from "../../src/lib/state-store-registrations";
import { OAUTH_PROVIDERS, reconcileOAuthProviders } from "../../src/oauth";
import { runModelRenameStartupMigration } from "../../src/providers/model-rename-startup";
import { startServer } from "../../src/server";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { CURSOR_STATIC_MODELS, cursorModelIds } from "../../src/adapters/cursor/discovery";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

/**
 * Sandboxed agent environments deny `Bun.serve` outright ("Is port 0 in use?", EADDRINUSE on
 * every port), which is an environment artifact and not a regression — the same class already
 * documented for tests/server/server-combo-failover-e2e.test.ts. Probe once so the
 * listener-bound assertion is hosted-CI-only while the boot-sequence assertions always run.
 *
 * The probe has to be `Bun.serve` itself: a `node:net` listener still binds in an environment
 * where Bun's does not, so probing with the wrong API reports a false green and the skip never
 * fires.
 */
function canBindLoopback(): boolean {
  try {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

const CAN_BIND = canBindLoopback();

test.skipIf(!CAN_BIND)("startServer persists the Astra-first legacy roster upgrade", async () => {
  saveConfig({
    ...staleConfig(),
    subagentModels: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"],
  });
  const server = startServer(0);
  try {
    const saved = loadConfig();
    expect(saved.subagentModels).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
    expect(saved.subagentModelsVersion).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test.skipIf(!CAN_BIND)("startServer migrates old Grok Chat choices once and preserves later opt-in", async () => {
  saveConfig({
    ...staleConfig(), defaultProvider: "xai",
    providers: { xai: {
      adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth",
      modelAdapters: { "grok-4.6": "openai-chat", "grok-4.5": "openai-chat" },
    } },
  });
  const server = startServer(0);
  try {
    const upgraded = loadConfig();
    expect(upgraded.providers.xai!.xaiResponsesDefaultVersion).toBe(1);
    for (const model of ["grok-4.6", "grok-4.5"]) {
      expect(resolveWireProtocolOverride("xai", model, upgraded.providers.xai!).adapter).toBe("openai-responses");
    }
    upgraded.providers.xai!.modelAdapters = { "grok-4.6": "openai-chat", "grok-4.5": "openai-chat" };
    saveConfig(upgraded);
  } finally { await server.stop(true); }
  const restarted = startServer(0);
  try {
    const optedIn = loadConfig();
    for (const model of ["grok-4.6", "grok-4.5"]) {
      expect(resolveWireProtocolOverride("xai", model, optedIn.providers.xai!).adapter).toBe("openai-chat");
    }
  } finally { await restarted.stop(true); }
});

test.skipIf(!CAN_BIND)("preset reconciliation cannot undo an in-memory Grok migration after its write fails", async () => {
  saveConfig({
    ...staleConfig(), defaultProvider: "xai",
    providers: { xai: {
      ...structuredClone(OAUTH_PROVIDERS.xai.providerConfig), authMode: "oauth",
      noVisionModels: ["stale-model"],
      modelAdapters: { "grok-4.6": "openai-chat", "grok-4.5": "openai-chat" },
    } },
  });
  const originalMutation = configStore.mutatePersistedConfig;
  let rejectedMigration = false;
  const mutation = spyOn(configStore, "mutatePersistedConfig").mockImplementation((mutate, ...rest) =>
    originalMutation(fresh => {
      const result = mutate(fresh);
      if (!rejectedMigration && fresh.providers.xai?.xaiResponsesDefaultVersion === 1) {
        rejectedMigration = true;
        throw new Error("injected migration write failure");
      }
      return result;
    }, ...rest));
  const live = spyOn(stateStores, "setLiveStateStoreConfig");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let server: ReturnType<typeof startServer> | undefined;
  try {
    server = startServer(0);
    expect(rejectedMigration).toBe(true);
    const liveConfig = live.mock.calls[0]![0];
    expect(liveConfig.providers.xai!.xaiResponsesDefaultVersion).toBe(1);
    expect(resolveWireProtocolOverride("xai", "grok-4.6", liveConfig.providers.xai!).adapter).toBe("openai-responses");
  } finally {
    mutation.mockRestore(); live.mockRestore(); warn.mockRestore();
    await server?.stop(true);
  }
});

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

/** A saved config that reconciliation genuinely rewrites, so the persistence path is reached. */
function staleConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "cursor",
    providers: {
      cursor: {
        ...structuredClone(OAUTH_PROVIDERS.cursor.providerConfig),
        authMode: "oauth",
        noVisionModels: cursorModelIds(CURSOR_STATIC_MODELS),
      },
    },
  } as OcxConfig;
}

/** The exact startup sequence src/server/index.ts runs at :651 and :663, and nothing else. */
function runStartupReconciliation(config: OcxConfig): void {
  reconcileOAuthProviders(runModelRenameStartupMigration(config));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-startup-reconcile-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-startup-reconcile-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

test("a config removed between loadConfig() and reconcile does not throw on the boot path", () => {
  saveConfig(staleConfig());
  const config = loadConfig();
  rmSync(getConfigPath());
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => runStartupReconciliation(config)).not.toThrow();
    // Degrading is not the same as doing nothing: the running process still gets the
    // reconciled catalog, it just never reaches disk.
    expect(config.providers.cursor.noVisionModels)
      .toEqual(OAUTH_PROVIDERS.cursor.providerConfig.noVisionModels);
  } finally {
    warn.mockRestore();
  }
});

test("a config hand-edited into invalid JSON does not throw on the boot path", () => {
  saveConfig(staleConfig());
  const config = loadConfig();
  writeFileSync(getConfigPath(), "{ this is not json");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => runStartupReconciliation(config)).not.toThrow();
  } finally {
    warn.mockRestore();
  }
});

test("a fresh install with no config file at all does not throw on the boot path", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(() => runStartupReconciliation(loadConfig())).not.toThrow();
  } finally {
    warn.mockRestore();
  }
});

// Hosted-CI-only: binds a listener, which sandboxed agent environments refuse (see
// canBindLoopback above). The three assertions above cover the same claim without a port.
test.skipIf(!CAN_BIND)(
  "startServer completes and serves /healthz when the config disappears before reconcile",
  async () => {
    saveConfig(staleConfig());
    // Removing the file after the save reproduces the operator-visible shape: every persisted
    // mutation under startServer is "unavailable" for the rest of the boot.
    rmSync(getConfigPath());
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(response.ok).toBe(true);
    } finally {
      await server.stop(true);
      warn.mockRestore();
    }
  },
);
