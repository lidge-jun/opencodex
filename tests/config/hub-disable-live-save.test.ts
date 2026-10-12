import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armClaudeCodeBaseline, getConfigPath, loadConfig, mutatePersistedConfig, reconcileLiveConfigFromDisk, saveConfig, saveConfigPreservingClaudeCode, validateConfigCandidate } from "../../src/config";
import { clearClientConnection, commitClientConnection } from "../../src/client/state";
import { disableHubConfig, parseHubDisableArgs } from "../../src/cli/hub-disable";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const key = (id: string) => ({ id, name: id, key: `ocx_data_${id.padEnd(40, "a")}`, createdAt: "2026-01-01T00:00:00.000Z" });
const seed = (): OcxConfig => ({
  port: 10100, hostname: "100.64.0.10", runtimeRole: "hub", logLevel: "debug",
  hub: { managementIngress: { enabled: true, port: 10102 } },
  unauthenticatedLoopbackListener: { enabled: true, port: 10103 },
  providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } },
  defaultProvider: "fixture", apiKeys: [key("client"), key("integration")],
} as OcxConfig);

function scenario(change: (live: OcxConfig) => void, changeDisk?: (disk: OcxConfig) => void, oauth = false, disable = true, initial = seed(), afterDiskChange?: () => void): { live: OcxConfig; saved: OcxConfig } {
  const oldHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-hub-live-save-"));
  process.env.OPENCODEX_HOME = home;
  try {
    saveConfig(initial);
    const live = loadConfig();
    const persistedBaseline = structuredClone(live);
    armClaudeCodeBaseline(live);
    if (disable) expect(mutatePersistedConfig(config => ({ changed: true, value: disableHubConfig(config, parseHubDisableArgs(["--revoke-clients", "--client-key", "client"])) })).status).toBe("committed");
    // Another cooperating writer adds a disjoint key before the stale live save.
    expect(mutatePersistedConfig(config => {
      config.apiKeys!.push(key("external"));
      changeDisk?.(config);
      return { changed: true, value: null };
    }).status).toBe("committed");
    afterDiskChange?.();
    if (oauth) reconcileLiveConfigFromDisk(live, persistedBaseline);
    change(live);
    saveConfigPreservingClaudeCode(live);
    // Repeated saves must not consume the disk's desired listener deletion.
    live.logLevel = "warn";
    saveConfigPreservingClaudeCode(live);
    return { live, saved: JSON.parse(readFileSync(getConfigPath(), "utf8")) };
  } finally {
    if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = oldHome;
    removeTreeWithRetry(home);
  }
}

function expectDisabled(result: { live: OcxConfig; saved: OcxConfig }) {
  expect(result.saved.apiKeys!.some(entry => entry.id === "client")).toBe(false);
  expect(result.saved.apiKeys!.some(entry => entry.id === "external")).toBe(true);
  expect(result.saved.hub).toBeUndefined();
  expect(result.saved.runtimeRole).toBeUndefined();
  expect(result.saved.hostname).toBeUndefined();
  expect(result.saved.port).toBe(10100);
  expect(result.live.hostname).toBe("100.64.0.10"); // actual open socket identity
  expect(result.live.runtimeRole).toBe("hub");
  expect(result.live.hub).toEqual(seed().hub);
  expect(result.live.unauthenticatedLoopbackListener).toEqual(seed().unauthenticatedLoopbackListener);
  expect(result.saved.unauthenticatedLoopbackListener).toBeUndefined();
  expect(result.saved.configRebaseProvenance?.deletedTopLevelKeys).toContain("hostname");
}

test("hub disable survives live key creation and preserves concurrent keys", () => {
  const result = scenario(live => live.apiKeys!.push(key("new-integration")));
  expectDisabled(result);
  expect(result.saved.apiKeys!.map(entry => entry.id)).toEqual(["integration", "new-integration", "external"]);
});

test("hub disable survives stale key rename without reviving the deleted ID", () => {
  const result = scenario(live => {
    live.apiKeys![0]!.name = "stale rename";
    live.apiKeys![1]!.name = "retained rename";
  });
  expectDisabled(result);
  expect(result.saved.apiKeys!.find(entry => entry.id === "integration")!.name).toBe("retained rename");
});

test("hub disable survives rotation and preserves unselected pending rotations", () => {
  const rotation = { id: "rotate", key: "ocx_data_" + "r".repeat(40), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" };
  const result = scenario(live => {
    live.apiKeys![0]!.pendingRotation = rotation;
    live.apiKeys![1]!.pendingRotation = rotation;
  });
  expectDisabled(result);
  expect(result.saved.apiKeys!.find(entry => entry.id === "integration")!.pendingRotation).toEqual(rotation);
});

test("hub disable listener deletion survives unrelated live settings and repeated saves", () => {
  const result = scenario(live => { live.logLevel = "info"; });
  expectDisabled(result);
  expect(result.saved.logLevel).toBe("warn");
});

test("retained keys merge a live rename with a concurrent persisted rotation", () => {
  const rotation = { id: "disk-rotate", key: "ocx_data_" + "p".repeat(40), createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" };
  const result = scenario(live => { live.apiKeys![1]!.name = "live rename"; }, disk => { disk.apiKeys![0]!.pendingRotation = rotation; });
  expectDisabled(result);
  expect(result.saved.apiKeys!.find(entry => entry.id === "integration")).toMatchObject({ name: "live rename", pendingRotation: rotation });
});

test("persisted API-key order survives a live rename without membership or order edits", () => {
  const result = scenario(live => { live.apiKeys![1]!.name = "live rename"; }, disk => { disk.apiKeys!.reverse(); });
  expect(result.saved.apiKeys!.map(entry => entry.id)).toEqual(["external", "integration"]);
  expect(result.saved.apiKeys![1]!.name).toBe("live rename");
});

test("OAuth disk adoption keeps the running hub topology until restart", () => {
  expectDisabled(scenario(live => { live.logLevel = "info"; }, undefined, true));
});

test.each([false, true])("desired topology additions/updates survive repeated saves (OAuth adoption=%s)", oauth => {
  const result = scenario(live => { live.logLevel = "info"; }, disk => {
    disk.hub!.managementPublicOrigin = "https://new-hub.example.test";
    disk.hub!.managementIngress!.port = 10112;
    disk.unauthenticatedLoopbackListener!.port = 10113;
  }, oauth, false);
  expect(result.saved.hub!.managementPublicOrigin).toBe("https://new-hub.example.test");
  expect(result.saved.hub!.managementIngress!.port).toBe(10112);
  expect(result.saved.unauthenticatedLoopbackListener!.port).toBe(10113);
  expect(result.live.hub).toEqual(seed().hub);
  expect(result.live.unauthenticatedLoopbackListener).toEqual(seed().unauthenticatedLoopbackListener);
});

test.each([false, true])("client connect/disconnect remain paired through repeated saves (OAuth adoption=%s)", oauth => {
  const initial = seed();
  delete initial.runtimeRole;
  delete initial.hub;
  delete initial.unauthenticatedLoopbackListener;
  const connection: NonNullable<OcxConfig["client"]> = {
    serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test",
    managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "fixture-client", tokenFingerprint: "a".repeat(64), protocolVersion: 1,
    connectedAt: "2026-01-01T00:00:00.000Z",
  };
  const connected = scenario(live => { live.logLevel = "info"; }, undefined, oauth, false, initial,
    () => { expect(commitClientConnection(connection)).toBe("committed"); });
  expect(connected.saved.runtimeRole).toBe("client");
  expect(connected.saved.client).toEqual(connection);
  expect(validateConfigCandidate(connected.saved).ok).toBe(true);
  expect(connected.live.runtimeRole).toBeUndefined();
  expect(connected.live.client).toBeUndefined();
  initial.runtimeRole = "client";
  initial.client = structuredClone(connection);
  const disconnected = scenario(live => { live.logLevel = "info"; }, undefined, oauth, false, initial,
    () => { expect(clearClientConnection(connection)).toBe("committed"); });
  expect(disconnected.saved.runtimeRole).toBeUndefined();
  expect(disconnected.saved.client).toBeUndefined();
  expect(validateConfigCandidate(disconnected.saved).ok).toBe(true);
  expect(disconnected.live.runtimeRole).toBe("client");
  expect(disconnected.live.client).toEqual(connection);
});
