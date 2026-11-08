import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getDefaultConfig, saveConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import * as desiredState from "../../src/codex/desired-state";
import * as configPaths from "../../src/config/paths";
import { handleManagementAPI } from "../../src/server/management-api";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { withConfigMutationLockSync } from "../../src/config/mutation-lock";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { asideHomeDir } from "../../src/clients/config-export";
import { initializeHomeRouteIntentDefaults } from "../../src/routing/home-route-intent";
import { readRouteIntentState, routeIntentStatePath, setRouteClientIntent } from "../../src/routing/route-intent-state";
import { handleNativeIntegrationRoutes } from "../../src/server/management/native-integration-routes";
import { writeLinkStore } from "../../src/link/store";
import { linkStorePath } from "../../src/link/paths";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let config: OcxConfig;
let previousEnv: Record<string, string | undefined>;
let restores: Array<() => void>;
beforeEach(() => {
  home = createTempHome("native-intent-errors-");
  const homedir = spyOn(os, "homedir").mockReturnValue(home.root);
  restores = [() => homedir.mockRestore()];
  previousEnv = {};
  for (const [key, path] of Object.entries({ HOME: "", USERPROFILE: "", GROK_HOME: "grok", CLAUDE_CONFIG_DIR: "claude",
    OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: "desktop", CLAUDE_USER_DATA_DIR: "desktop-user" })) {
    previousEnv[key] = process.env[key]; process.env[key] = home.path(path);
  }
  config = getDefaultConfig();
  config.claudeCode = { enabled: true };
  saveConfig(config);
  mkdirSync(home.path("grok")); writeFileSync(home.path("grok", "config.toml"), "# fixture\n");
  // Route intent bookkeeping belongs to a Home with a Child; an unlinked Home's toggle never reads it.
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: "lnk_0123456789abcdef", alias: "child",
    direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 19200, apiKeyId: "key-test", createdAt: "2026-11-07T00:00:00.000Z" }] });
});
afterEach(() => {
  for (const restore of restores.reverse()) restore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  home.remove();
});

async function toggle(client: string, deps: ManagementContext["deps"] = {}, enabled = false, context: Partial<ManagementContext> = {}) {
  const req = new Request(`http://localhost/api/native-integrations/${client}`, { method: "PUT", body: JSON.stringify({ enabled }) });
  const response = await handleNativeIntegrationRoutes({ req, url: new URL(req.url), config, version: "test", deps, ...context } as ManagementContext);
  return { status: response!.status, body: await response!.json() };
}
function ownAside() {
  expect(asideHomeDir()).toBe(home.path(".aside"));
  createIntegrationStateStore().putRecord({ clientId: "aside", configPath: home.path(".aside", "u", "0", "models.json"),
    fileFingerprint: "a".repeat(16), blockFingerprint: "b".repeat(16), fragmentPaths: [["models"]],
    opId: "fixture", appliedAt: "2026-01-01T00:00:00.000Z" });
  mkdirSync(home.path(".aside"));
}

for (const client of ["codex", "grok", "claude", "claude-desktop"]) {
  for (const manifest of ["missing", "missing-user-id", "malformed", "unreadable"] as const) {
    test(`${client}: ${manifest} owned Aside manifest refuses with recovery and preserves policy`, async () => {
      ownAside();
      const path = home.path(".aside", "accounts.json");
      if (manifest === "missing-user-id") writeFileSync(path, JSON.stringify({ accounts: [{ id: 0 }] }));
      if (manifest === "malformed") writeFileSync(path, "{private-fixture-details");
      if (manifest === "unreadable") mkdirSync(path); // deterministic regular-file read refusal, even as root
      const before = readFileSync(home.path("config.json"), "utf8");
      const result = await toggle(client);
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ code: "native_integration_refused", clientId: client, reason: "metadata_unreadable" });
      expect(result.body.message).toContain("manifest");
      expect(result.body.message).toContain("ocx route to aside on");
      expect(result.body.message).toContain("ocx route to aside off");
      expect(JSON.stringify(result.body)).not.toContain(home.root);
      expect(JSON.stringify(result.body)).not.toContain("private-fixture-details");
      expect(result.body.desiredEnabled).toBeUndefined();
      expect(existsSync(routeIntentStatePath())).toBe(false);
      expect(readFileSync(home.path("config.json"), "utf8")).toBe(before);
    });
  }

  test(`${client}: an unlinked Home toggles without reading an owned Aside manifest or route intent`, async () => {
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [] });
    ownAside();
    writeFileSync(home.path(".aside", "accounts.json"), "{private-fixture-details");
    const result = await toggle(client);
    expect(result.status).toBe(200);
    expect(existsSync(routeIntentStatePath())).toBe(false);
  });
}

for (const enabled of [false, true]) {
  test(`explicit Home Aside ${enabled} recovers without replacing that policy`, async () => {
    ownAside(); setRouteClientIntent("aside", { enabled, ...(enabled ? { accounts: "all" as const } : {}) });
    expect((await toggle("claude")).status).toBe(200);
    expect(readRouteIntentState().defaults.aside).toEqual({ enabled, ...(enabled ? { accounts: "all" } : {}) });
  });
}

test("a corrupt config coordinator is a sanitized persistence failure, not retryable contention", async () => {
  writeFileSync(home.path("config-mutation.sqlite"), "not a database: private-fixture-details");
  const result = await toggle("claude");
  expect(result.status).toBe(500);
  expect(result.body).toMatchObject({ reason: "write_failed", code: "native_integration_failed", diagnostic: { stage: "config", cause: "SQLITE_NOTADB" } });
  expect(result.body.desiredEnabled).toBeUndefined();
  expect(JSON.stringify(result.body)).not.toContain(home.root);
  expect(JSON.stringify(result.body)).not.toContain("private-fixture-details");
});

test("the config lock remains held after legacy publication until Home intent is recorded", async () => {
  initializeHomeRouteIntentDefaults(config, "test");
  const holder = new Database(home.path("config-mutation.sqlite"));
  let acquired = false;
  try {
    const result = await toggle("claude", { saveConfigPreservingClaudeCode: current => {
      saveConfigPreservingClaudeCode(current);
      expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).claudeCode.enabled).toBe(false);
      try { holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); acquired = true; }
      catch (error) { expect((error as { code: string }).code).toBe("SQLITE_BUSY"); }
    } });
    expect(result.status).toBe(200);
    expect(acquired).toBe(false);
    expect(readRouteIntentState().devices).toEqual({});
  } finally { if (acquired) holder.exec("ROLLBACK"); holder.close(); }
});

for (const client of ["codex", "grok", "claude", "claude-desktop"] as const) {
  test(`${client}: failed Home intent write after publication returns an honest recoverable refusal`, async () => {
    initializeHomeRouteIntentDefaults(config, "test");
    const corruptIntent = () => writeFileSync(routeIntentStatePath(), "{private-fixture-details");
    const deps: ManagementContext["deps"] = {};
    if (client === "claude") deps.saveConfigPreservingClaudeCode = current => { saveConfigPreservingClaudeCode(current); corruptIntent(); };
    else {
      const original = desiredState.setIntegrationEnabled;
      const persist = () => { const result = original(client, false); expect(result.ok).toBe(true); corruptIntent(); return result; };
      const hook = client === "codex" ? spyOn(desiredState, "setCodexIntegrationEnabled").mockImplementation(persist)
        : client === "grok" ? spyOn(desiredState, "setGrokIntegrationEnabled").mockImplementation(persist)
          : spyOn(desiredState, "setIntegrationEnabled").mockImplementation(persist);
      restores.push(() => hook.mockRestore());
    }
    const result = await toggle(client, deps);
    const disk = JSON.parse(readFileSync(home.path("config.json"), "utf8"));
    expect(client === "claude" ? disk.claudeCode.enabled : disk.clientIntegrations[client]).toBe(false);
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ reason: "write_failed", clientId: client, desiredEnabled: false });
    expect(result.body.message).not.toContain("Nothing was written");
    expect(result.body.message).toMatch(/repair|recover|retry/i);
    expect(JSON.stringify(result.body)).not.toContain(home.root);
    expect(JSON.stringify(result.body)).not.toContain("private-fixture-details");
  });
}

for (const client of ["codex", "grok", "claude", "claude-desktop"] as const) {
  test(`${client}: published-then-error retains the saved decision and reports sanitized recovery`, async () => {
    const failPublished = (): never => { throw new ConfigWritePublishedError(new Error(`private-fixture-details ${home.root}`)); };
    const deps: ManagementContext["deps"] = {};
    if (client === "claude") deps.saveConfigPreservingClaudeCode = current => { saveConfigPreservingClaudeCode(current); failPublished(); };
    else {
      const original = desiredState.setIntegrationEnabled;
      const persist = () => { expect(original(client, false).ok).toBe(true); return failPublished(); };
      const hook = client === "codex" ? spyOn(desiredState, "setCodexIntegrationEnabled").mockImplementation(persist)
        : client === "grok" ? spyOn(desiredState, "setGrokIntegrationEnabled").mockImplementation(persist)
          : spyOn(desiredState, "setIntegrationEnabled").mockImplementation(persist);
      restores.push(() => hook.mockRestore());
    }
    const result = await toggle(client, deps);
    expect(result.status).toBe(500);
    const disk = JSON.parse(readFileSync(home.path("config.json"), "utf8"));
    expect(client === "claude" ? disk.claudeCode.enabled : disk.clientIntegrations[client]).toBe(false);
    if (client === "claude") expect(config.claudeCode?.enabled).toBe(false);
    if (client === "claude-desktop") expect(config.clientIntegrations?.[client]).toBe(false);
    expect(result.body).toMatchObject({ reason: "write_failed", desiredEnabled: false });
    expect(result.body.message).toMatch(/repair|recover|retry/i);
    expect(JSON.stringify(result.body)).not.toContain(home.root);
    expect(JSON.stringify(result.body)).not.toContain("private-fixture-details");
  });
}

test("real contention during post-decision Claude reconcile never claims nothing was written", async () => {
  initializeHomeRouteIntentDefaults(config, "test");
  const holder = new Database(home.path("config-mutation.sqlite"));
  let acquired = false;
  try {
    const result = await toggle("claude", {}, false, { syncClaudeAgentDefsBestEffort: async () => {
      expect(readRouteIntentState().devices).toEqual({});
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); acquired = true;
      withConfigMutationLockSync(() => {});
    } });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ reason: "config_busy", desiredEnabled: false });
    expect(result.body.message).not.toContain("Nothing was written");
    expect(result.body.message).toMatch(/retry|recover/i);
    expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).claudeCode.enabled).toBe(false);
  } finally { if (acquired) holder.exec("ROLLBACK"); holder.close(); }
});

test("Claude native OFF recomputes its decision after a competing ON during ACL admission", async () => {
  config.claudeCode = { enabled: false };
  saveConfig(config);
  const settle = configPaths.withConfigDirHardeningSettled;
  let calls = 0, competing = false;
  const hook = spyOn(configPaths, "withConfigDirHardeningSettled").mockImplementation(async (root, mutate) => {
    if (++calls === 2) {
      const url = new URL("http://localhost/api/claude-code");
      const response = await handleManagementAPI(new Request(url, { method: "PUT", headers: { "content-type": "application/json", Host: url.host },
        body: JSON.stringify({ enabled: true }) }), url, config, {}, "admin-token", undefined, { trustedLoopback: true });
      expect(response?.status).toBe(200);
      expect(config.claudeCode?.enabled).toBe(true);
      competing = true;
    }
    return settle(root, mutate);
  });
  restores.push(() => hook.mockRestore());
  const result = await toggle("claude");
  expect(competing).toBe(true);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ changed: true, state: "absent", desiredEnabled: false });
  expect(config.claudeCode?.enabled).toBe(false);
  expect(JSON.parse(readFileSync(home.path("config.json"), "utf8")).claudeCode.enabled).toBe(false);
  expect(readRouteIntentState().devices).toEqual({});
});
