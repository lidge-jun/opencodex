import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDesktopFirstParty,
  observeClaudeDesktopMode,
  resolveClaudeDesktopMode,
} from "../../src/claude/desktop-first-party";
import type { writeDesktop3pConfig } from "../../src/claude/desktop-3p";
import { handleManagementAPI } from "../../src/server/management-api";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { syncEnabledClientIntegrations } from "../../src/server/management/config-routes";
import type { CatalogModel } from "../../src/codex/catalog";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Gateway is the default Desktop mode. These guards keep that default from ever writing a
// gateway profile behind a Desktop that runs first-party, and keep foreign proxy env from being
// read as a first-party install.

let root = "";
let library = "";
let claudeDir = "";
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    clientIntegrations: { grok: false },
    providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["keep"] } },
    ...extra,
  } as OcxConfig;
}

function persisted(): OcxConfig {
  return JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as OcxConfig;
}

async function dispatch(path: string, init: RequestInit, inputConfig: OcxConfig, deps: Parameters<typeof handleManagementAPI>[3] = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const response = await handleManagementAPI(new Request(url, {
    ...init,
    headers: { Host: url.host, "Content-Type": "application/json", ...(init.headers ?? {}) },
  }), url, inputConfig, deps);
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

/** Apply the real gateway profile so Desktop's library holds our selected row. */
async function applyGateway(): Promise<OcxConfig> {
  const applied = await dispatch("/api/claude-desktop/apply", { method: "POST", body: JSON.stringify({ mode: "gateway" }) }, config(), {
    fetchAllModels: async () => [],
  });
  expect(applied.status).toBe(200);
  return persisted();
}

function gatedDiscovery(models: CatalogModel[]) {
  let release!: () => void;
  let announce!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { announce = resolve; });
  let calls = 0;
  return {
    started,
    release: () => release(),
    get calls() { return calls; },
    fetchAllModels: async () => {
      calls += 1;
      announce();
      await gate;
      return models;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-desktop-1p-guards-"));
  library = join(root, "desktop-library");
  claudeDir = join(root, "claude");
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.OPENCODEX_HOME = root;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  writeFileSync(join(root, "config.json"), JSON.stringify(config()));
});

afterEach(() => {
  resetSiblingStartForTests();
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

test("a sibling roster update leaves an owned Desktop gateway profile untouched", async () => {
  const gateway = await applyGateway();
  expect(gateway.claudeCode?.desktopProfile).toBeTruthy();
  markSiblingStart(10101);
  let discoveries = 0;
  let writes = 0;
  const reply = await dispatch("/api/subagent-models", {
    method: "PUT", body: JSON.stringify({ models: ["mock/keep"] }),
  }, gateway, {
    fetchAllModels: async () => { discoveries += 1; return [{ provider: "mock", id: "keep", contextWindow: 123_000 }]; },
    writeDesktop3pConfig: () => { writes += 1; return { written: true, path: "fixture", fingerprint: "fedcba9876543210" }; },
  });
  expect(reply.status).toBe(200);
  expect(discoveries).toBe(0);
  expect(writes).toBe(0);
});

test("a sibling mark arriving during roster discovery still prevents the Desktop write", async () => {
  const gateway = await applyGateway();
  const discovery = gatedDiscovery([{ provider: "mock", id: "keep", contextWindow: 123_000 }]);
  let writes = 0;
  const request = dispatch("/api/subagent-models", {
    method: "PUT", body: JSON.stringify({ models: ["mock/keep"] }),
  }, gateway, {
    fetchAllModels: discovery.fetchAllModels,
    writeDesktop3pConfig: () => { writes += 1; return { written: true, path: "fixture", fingerprint: "fedcba9876543210" }; },
  });
  try {
    await Promise.race([
      discovery.started,
      request.then(() => { throw new Error("roster update ended before Desktop discovery"); }),
    ]);
    markSiblingStart(10101);
  } finally {
    discovery.release();
  }
  expect((await request).status).toBe(200);
  expect(writes).toBe(0);
});

test("a foreign HTTPS_PROXY in Claude Code settings is not first-party evidence", () => {
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy.example:3128" } }));
  const observed = observeClaudeDesktopMode(config());
  expect(observed).toEqual({ ownedGatewaySelected: false, ownedFirstPartySettings: false });
  expect(resolveClaudeDesktopMode(config(), observed)).toBe("gateway");
});

test("owned first-party env keeps a pre-field install first-party, and a selected owned gateway row outranks it", async () => {
  expect(applyDesktopFirstParty(config()).ok).toBe(true);
  const firstPartyOnly = observeClaudeDesktopMode(config());
  expect(firstPartyOnly).toEqual({ ownedGatewaySelected: false, ownedFirstPartySettings: true });
  expect(resolveClaudeDesktopMode(config(), firstPartyOnly)).toBe("first-party");

  const gateway = await applyGateway();
  // The gateway apply removes the first-party env; put it back to model a hand-restored leftover.
  expect(applyDesktopFirstParty(config()).ok).toBe(true);
  const unmarked = { ...gateway, claudeCode: { ...gateway.claudeCode, desktopMode: undefined } };
  const both = observeClaudeDesktopMode(unmarked);
  expect(both).toEqual({ ownedGatewaySelected: true, ownedFirstPartySettings: true });
  expect(resolveClaudeDesktopMode(unmarked, both)).toBe("gateway");
});

for (const switchDuringDiscovery of [false, true]) {
  test(`/api/sync Desktop writer ${switchDuringDiscovery ? "skips a switch to first-party during discovery" : "still writes while the mode stays gateway"}`, async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify(config()));
    const discovery = gatedDiscovery([{ provider: "mock", id: "keep", contextWindow: 123_000 }]);
    const writes: Parameters<typeof writeDesktop3pConfig>[] = [];
    const sync = syncEnabledClientIntegrations(10100, config(), {
      fetchAllModels: discovery.fetchAllModels,
      refreshOwnedCatalogIntegrations: async () => [],
      writeDesktop3pConfig: (...args) => {
        writes.push(args);
        return { written: true, path: "fixture", fingerprint: "0123456789abcdef" };
      },
    });
    try {
      await Promise.race([
        discovery.started,
        sync.then(() => { throw new Error("sync ended without entering Desktop discovery"); }),
      ]);
      if (switchDuringDiscovery) writeFileSync(join(root, "config.json"), JSON.stringify(config({ claudeCode: { desktopMode: "first-party" } })));
    } finally {
      discovery.release();
    }
    const outcomes = await sync;
    expect(writes.length).toBe(switchDuringDiscovery ? 0 : 1);
    expect(outcomes.some(outcome => outcome.client === "claude-desktop")).toBe(!switchDuringDiscovery);
  });
}

test("/api/sync never enters Desktop discovery for a first-party install", async () => {
  const chosen = config({ claudeCode: { desktopMode: "first-party" } });
  writeFileSync(join(root, "config.json"), JSON.stringify(chosen));
  let discovered = 0;
  const writes: unknown[] = [];
  const outcomes = await syncEnabledClientIntegrations(10100, chosen, {
    fetchAllModels: async () => { discovered += 1; return []; },
    refreshOwnedCatalogIntegrations: async () => [],
    writeDesktop3pConfig: (...args) => { writes.push(args); return { written: true, path: "fixture", fingerprint: "0123456789abcdef" }; },
  });
  expect(discovered).toBe(0);
  expect(writes).toEqual([]);
  expect(outcomes.some(outcome => outcome.client === "claude-desktop")).toBe(false);
});

for (const switchDuringDiscovery of [false, true]) {
  test(`roster update auto-apply ${switchDuringDiscovery ? "skips a switch to first-party during discovery" : "still rewrites the owned gateway profile"}`, async () => {
    const gateway = await applyGateway();
    // Keep the saved profile but drop the explicit marker, so only the switch below can make it first-party.
    const live = { ...gateway, claudeCode: { ...gateway.claudeCode, desktopMode: undefined } } as OcxConfig;
    writeFileSync(join(root, "config.json"), JSON.stringify(live));
    const discovery = gatedDiscovery([{ provider: "mock", id: "keep", contextWindow: 123_000 }]);
    const writes: unknown[] = [];
    const request = dispatch("/api/subagent-models", { method: "PUT", body: JSON.stringify({ models: ["mock/keep"] }) }, live, {
      fetchAllModels: discovery.fetchAllModels,
      writeDesktop3pConfig: (...args) => {
        writes.push(args);
        return { written: true, path: "fixture", fingerprint: "fedcba9876543210" };
      },
    });
    try {
      await Promise.race([
        discovery.started,
        request.then(() => { throw new Error("roster update ended without entering Desktop discovery"); }),
      ]);
      if (switchDuringDiscovery) {
        const current = persisted();
        writeFileSync(join(root, "config.json"), JSON.stringify({ ...current, claudeCode: { ...current.claudeCode, desktopMode: "first-party" } }));
      }
    } finally {
      discovery.release();
    }
    const reply = await request;
    expect(reply.status).toBe(200);
    expect(writes.length).toBe(switchDuringDiscovery ? 0 : 1);
  });
}

test("roster update auto-apply never writes behind an explicit first-party marker, even over an owned gateway row", async () => {
  const gateway = await applyGateway();
  const chosen = { ...gateway, claudeCode: { ...gateway.claudeCode, desktopMode: "first-party" as const } };
  writeFileSync(join(root, "config.json"), JSON.stringify(chosen));
  let discovered = 0;
  const writes: unknown[] = [];
  const reply = await dispatch("/api/subagent-models", { method: "PUT", body: JSON.stringify({ models: ["mock/keep"] }) }, chosen, {
    fetchAllModels: async () => { discovered += 1; return []; },
    writeDesktop3pConfig: (...args) => { writes.push(args); return { written: true, path: "fixture", fingerprint: "fedcba9876543210" }; },
  });
  expect(reply.status).toBe(200);
  expect(discovered).toBe(0);
  expect(writes).toEqual([]);
});
