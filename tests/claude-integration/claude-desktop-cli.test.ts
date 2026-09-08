import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProfile as applyProfileProduction, handleClaudeDesktopCommand as handleClaudeDesktopCommandProduction, type ApplyProfileDeps } from "../../src/cli/claude-desktop";
import * as managementApi from "../../src/server/management-api";
import { buildClaudeDesktopState } from "../../src/server/management-api";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { emptyDesktopProfile } from "../../src/claude/desktop-profile";
import { applyRemoteDesktopStore, restoreRemoteDesktopStore, writeDesktopDisconnectReceipt, type DesktopDisconnectReceipt } from "../../src/claude/desktop-remote-store";
import * as lifecycleLock from "../../src/client/lifecycle-lock";
import { readClientConnectionState, clearClientConnection } from "../../src/client/state";
import { HubClientError } from "../../src/client/hub-client";
import { claudeDesktopIntegrationEnabledNow, setIntegrationEnabled } from "../../src/codex/desired-state";
import { serviceApiTokenBackupPath, serviceApiTokenFilePath, writeServiceApiTokenFile } from "../../src/lib/service-secrets";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let dir = "";
let previousHome: string | undefined;
let previousDesktopDir: string | undefined;
let restoreLocalBuild: (() => void) | undefined;

const fixtureLock = () => ({ lockPath: join(dir, "lifecycle.sqlite") });
const applyProfile = (profile: Parameters<typeof applyProfileProduction>[0], mode: Parameters<typeof applyProfileProduction>[1], deps: ApplyProfileDeps = {}) =>
  applyProfileProduction(profile, mode, { lifecycleLockDeps: fixtureLock(), ...deps });
const handleClaudeDesktopCommand = (args: string[], deps: ApplyProfileDeps = {}) =>
  handleClaudeDesktopCommandProduction(args, { lifecycleLockDeps: fixtureLock(), ...deps });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousDesktopDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "ocx-desktop-cli-"));
  process.env.OPENCODEX_HOME = join(dir, "ocx");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(dir, "desktop");
  saveConfig({
    port: 10100,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  restoreLocalBuild?.();
  restoreLocalBuild = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopDir;
  removeTreeWithRetry(dir);
});

const remoteModels = [{
  name: "claude-opus-4-8-20260203", labelOverride: "Hub-selected model", anthropicFamilyTier: "sonnet" as const,
  isFamilyDefault: true, supports1m: true as const,
}];

function connectDesktopFixture(blockLocalBuild = true): void {
  const { fingerprint } = writeServiceApiTokenFile("ocx_desktop_fixture_token");
  const config = loadConfig();
  config.runtimeRole = "client";
  config.client = {
    serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
    selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "desktop-key",
    tokenFingerprint: fingerprint, protocolVersion: 1, connectedAt: "2026-09-06T00:00:00.000Z",
  };
  saveConfig(config);
  expect(readClientConnectionState().kind).toBe("connected");
  if (blockLocalBuild) {
    const spy = spyOn(managementApi, "buildClaudeDesktopState").mockImplementation(async () => {
      throw new Error("connected apply must not build local Desktop state");
    });
    restoreLocalBuild = () => spy.mockRestore();
  }
}

function pendingRotation(): NonNullable<NonNullable<OcxConfig["client"]>["pendingOperation"]> {
  return { kind: "rotate", rotationId: "rotation-fixture", newKeyIssuedAt: "2026-09-06T01:00:00.000Z", oldKeyBackupPath: serviceApiTokenBackupPath() };
}

function oldDesktopFile(): string {
  mkdirSync(join(dir, "desktop"), { recursive: true });
  const path = join(dir, "desktop", "existing.json");
  writeFileSync(path, "existing Desktop bytes");
  return path;
}

test.each([
  ["--static", "static"], ["--hybrid", "hybrid"], ["--discovery-only", "discovery"],
] as const)("connected CLI %s applies exact hub IDs without local reconciliation", async (flag, mode) => {
  connectDesktopFixture();
  setIntegrationEnabled("claude-desktop", false);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  let writtenPath = "";
  let downloads = 0;
  try {
    expect(await handleClaudeDesktopCommand(["apply", flag], {
      downloadDesktop3pModelsImpl: async (url, token) => {
        downloads++;
        expect(url).toBe("https://hub.example.test");
        expect(token).toBe("ocx_desktop_fixture_token");
        expect(claudeDesktopIntegrationEnabledNow()).toBe(true);
        return { version: 1, models: remoteModels };
      },
      applyRemoteDesktopStoreImpl: (held, options) => {
        expect(options).toEqual({ baseUrl: "https://hub.example.test", apiKey: "ocx_desktop_fixture_token", mode, models: remoteModels,
          owner: { serverUrl: "https://hub.example.test", apiKeyId: "desktop-key", connectedAt: "2026-09-06T00:00:00.000Z" },
          expectedTokenFingerprint: loadConfig().client!.tokenFingerprint });
        const result = applyRemoteDesktopStore(held, options);
        writtenPath = result.ok ? result.path ?? "" : "";
        return result;
      },
      findLiveProxyImpl: async () => { throw new Error("must not look for local proxy"); },
      postApplyImpl: async () => { throw new Error("must not call local management"); },
      probeClaudeDesktopPolicy: () => "present",
    })).toBe(0);
    expect(downloads).toBe(1);
    const written = JSON.parse(readFileSync(writtenPath, "utf8"));
    expect(written.inferenceGatewayBaseUrl).toBe("https://hub.example.test");
    expect(written.inferenceGatewayApiKey).toBe("ocx_desktop_fixture_token");
    expect(written.inferenceModels).toEqual(mode === "discovery" ? undefined : remoteModels);
    expect(loadConfig().claudeCode?.desktopProfile).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Windows managed Claude policy is active"));
    expect(error).not.toHaveBeenCalled();
  } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
});

test.each([
  ["absent", "client_token_absent"],
  ["unsafe", "client_token_unsafe"],
  ["mismatch", "client_token_mismatch"],
  ["pending", "client_rotation_pending"],
  ["invalid", "client_connection_invalid"],
  ["mismatched", "client_connection_invalid"],
] as const)(
  "connected apply rejects %s state before download or writing", async (fault, reason) => {
    connectDesktopFixture();
    setIntegrationEnabled("claude-desktop", false);
    const oldPath = oldDesktopFile();
    writeFileSync(serviceApiTokenBackupPath(), "backup must remain");
    const config = loadConfig();
    if (fault === "absent" || fault === "unsafe") unlinkSync(serviceApiTokenFilePath());
    if (fault === "unsafe") mkdirSync(serviceApiTokenFilePath());
    if (fault === "mismatch") writeFileSync(serviceApiTokenFilePath(), "different-token");
    if (fault === "pending") { config.client!.pendingOperation = pendingRotation(); saveConfig(config); }
    if (fault === "invalid") writeFileSync(getConfigPath(), "{invalid-config");
    if (fault === "mismatched") writeFileSync(getConfigPath(), JSON.stringify({ ...config, runtimeRole: "hub" }));
    const configBefore = readFileSync(getConfigPath(), "utf8");
    let downloads = 0;
    let writes = 0;
    const result = await applyProfile(emptyDesktopProfile(), "static", {
      downloadDesktop3pModelsImpl: async () => { downloads++; return { version: 1, models: remoteModels }; },
      applyRemoteDesktopStoreImpl: () => { writes++; return { ok: true, changed: true, status: "applied", path: oldPath, restartRequired: true }; },
    });
    expect(result).toEqual({ ok: false, path: "", reason });
    expect(downloads).toBe(0);
    expect(writes).toBe(0);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(configBefore);
    if (fault === "absent" || fault === "unsafe" || fault === "mismatch") {
      expect(claudeDesktopIntegrationEnabledNow()).toBe(false);
    }
    expect(readFileSync(oldPath, "utf8")).toBe("existing Desktop bytes");
    expect(readFileSync(serviceApiTokenBackupPath(), "utf8")).toBe("backup must remain");
  },
);

test.each(["empty", "failed"])("connected CLI handles %s snapshot without claiming a saved local profile", async outcome => {
  connectDesktopFixture();
  const oldPath = oldDesktopFile();
  const error = spyOn(console, "error").mockImplementation(() => {});
  let writes = 0;
  try {
    expect(await handleClaudeDesktopCommand(["apply"], {
      downloadDesktop3pModelsImpl: async () => {
        if (outcome === "failed") throw new HubClientError("desktop_snapshot_unsupported", "remote-marker");
        return { version: 1, models: [] };
      },
      applyRemoteDesktopStoreImpl: () => { writes++; return { ok: true, changed: true, status: "applied", path: oldPath, restartRequired: true }; },
    })).toBe(1);
    expect(writes).toBe(0);
    expect(readFileSync(oldPath, "utf8")).toBe("existing Desktop bytes");
    expect(loadConfig().claudeCode?.desktopProfile).toBeUndefined();
    const output = error.mock.calls.flat().join(" ");
    expect(output).toContain(outcome === "empty" ? "desktop_unavailable" : "desktop_snapshot_unsupported");
    expect(output).not.toContain("프로필은 저장");
    expect(output).not.toContain("remote-marker");
    expect(output).not.toContain("ocx_desktop_fixture_token");
  } finally { error.mockRestore(); }
});

test.each(["off", "server", "key", "fingerprint", "connectedAt", "disconnect", "pending", "token", "invalid"])(
  "connected apply fences a %s transition during download", async transition => {
    connectDesktopFixture();
    const oldPath = oldDesktopFile();
    writeFileSync(serviceApiTokenBackupPath(), "backup must remain");
    let started!: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const downloadGate = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const applying = applyProfile(emptyDesktopProfile(), "static", {
      downloadDesktop3pModelsImpl: async () => { started(); await downloadGate; return { version: 1, models: remoteModels }; },
      applyRemoteDesktopStoreImpl: () => { writes++; return { ok: true, changed: true, status: "applied", path: oldPath, restartRequired: true }; },
    });
    await downloading;
    try {
      const config = loadConfig();
      if (transition === "off") setIntegrationEnabled("claude-desktop", false);
      else if (transition === "token") writeFileSync(serviceApiTokenFilePath(), "different-token");
      else if (transition === "invalid") writeFileSync(getConfigPath(), "{invalid-config");
      else {
        if (transition === "server") config.client!.serverUrl = "https://other.example.test";
        if (transition === "key") config.client!.apiKeyId = "other-key";
        if (transition === "fingerprint") config.client!.tokenFingerprint = "1".repeat(64);
        if (transition === "connectedAt") config.client!.connectedAt = "2026-09-06T02:00:00.000Z";
        if (transition === "pending") config.client!.pendingOperation = pendingRotation();
        if (transition === "disconnect") { config.runtimeRole = "standalone"; delete config.client; }
        saveConfig(config);
      }
    } finally { release(); }
    expect(await applying).toMatchObject({ ok: false, reason: transition === "off" ? "desired_state_changed" : "client_connection_changed" });
    expect(writes).toBe(0);
    expect(readFileSync(oldPath, "utf8")).toBe("existing Desktop bytes");
    expect(readFileSync(serviceApiTokenBackupPath(), "utf8")).toBe("backup must remain");
    if (transition === "off") expect(claudeDesktopIntegrationEnabledNow()).toBe(false);
  },
);

test("a prepared disconnect receipt rejects connected apply after its download", async () => {
  connectDesktopFixture();
  const oldPath = oldDesktopFile();
  let writes = 0;
  const result = await applyProfile(emptyDesktopProfile(), "static", {
    downloadDesktop3pModelsImpl: async () => {
      const connection = loadConfig().client!;
      lifecycleLock.withClientLifecycleSync(held => writeDesktopDisconnectReceipt(held, null, {
        version: 1, owner: { serverUrl: connection.serverUrl, apiKeyId: connection.apiKeyId, connectedAt: connection.connectedAt },
        tokenFingerprint: connection.tokenFingerprint, keepCatalog: false, phase: "prepared",
      }), fixtureLock());
      return { version: 1, models: remoteModels };
    },
    applyRemoteDesktopStoreImpl: () => { writes++; return { ok: true, changed: true, status: "applied", path: oldPath, restartRequired: true }; },
  });
  expect(result).toMatchObject({ ok: false, reason: "client_disconnect_pending" });
  expect(writes).toBe(0);
  expect(readFileSync(oldPath, "utf8")).toBe("existing Desktop bytes");
});

test("remote import --apply refuses before saving or building a local profile", async () => {
  connectDesktopFixture();
  const source = join(dir, "import.json");
  writeFileSync(source, JSON.stringify(emptyDesktopProfile()));
  const before = readFileSync(getConfigPath(), "utf8");
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["import", source, "--apply"])).toBe(2);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(error.mock.calls.flat().join(" ")).toContain("hub profile");
  } finally { error.mockRestore(); }
});

test("import --apply also refuses a connection established while local reconciliation awaited", async () => {
  const localState = await buildClaudeDesktopState(loadConfig());
  const source = join(dir, "import.json");
  writeFileSync(source, JSON.stringify(emptyDesktopProfile()));
  let builds = 0;
  const build = spyOn(managementApi, "buildClaudeDesktopState").mockImplementation(async () => {
    if (++builds === 2) connectDesktopFixture(false);
    return localState;
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  let downloads = 0;
  try {
    expect(await handleClaudeDesktopCommand(["import", source, "--apply"], {
      downloadDesktop3pModelsImpl: async () => { downloads++; return { version: 1, models: [] }; },
    })).toBe(2);
    expect(builds).toBe(2);
    expect(downloads).toBe(0);
    expect(loadConfig().claudeCode?.desktopProfile).toBeUndefined();
    expect(readClientConnectionState().kind).toBe("connected");
  } finally { build.mockRestore(); error.mockRestore(); }
});

test.each([
  ["move", "rotation"], ["default", "rotation"], ["import", "rotation"],
  ["move", "disconnect"], ["default", "disconnect"], ["import", "disconnect"],
] as const)("delayed %s cannot overwrite a %s transition", async (command, transition) => {
  connectDesktopFixture(false);
  const capturedState = await buildClaudeDesktopState(loadConfig());
  const originalProfile = structuredClone(loadConfig().claudeCode?.desktopProfile);
  const source = join(dir, "profile-race.json");
  writeFileSync(source, JSON.stringify(emptyDesktopProfile()));
  const args = command === "move" ? ["move", "mock/test-model", "sonnet"]
    : command === "default" ? ["default", "opus", "mock/test-model"] : ["import", source];
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const build = spyOn(managementApi, "buildClaudeDesktopState").mockImplementation(async () => {
    entered(); await gate; return capturedState;
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const pending = handleClaudeDesktopCommand(args);
  try {
    await started;
    if (transition === "rotation") {
      const current = loadConfig();
      writeFileSync(serviceApiTokenBackupPath(), readFileSync(serviceApiTokenFilePath()), { mode: 0o600 });
      current.client!.pendingOperation = pendingRotation();
      saveConfig(current);
    } else {
      // Construct an interrupted disconnect after its own token/state cleanup using
      // only this fixture's OCX files. The awaited local edit must not resurrect client.
      const current = loadConfig().client!;
      const owner = { serverUrl: current.serverUrl, apiKeyId: current.apiKeyId, connectedAt: current.connectedAt };
      lifecycleLock.withClientLifecycleSync(held => {
        let receipt: DesktopDisconnectReceipt = { version: 1, owner, tokenFingerprint: current.tokenFingerprint, keepCatalog: false, phase: "prepared" };
        writeDesktopDisconnectReceipt(held, null, receipt);
        const restored = restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [current.tokenFingerprint] });
        expect(restored.ok).toBe(true);
        const advance = (phase: DesktopDisconnectReceipt["phase"], fields: Partial<DesktopDisconnectReceipt> = {}) => {
          const next = { ...receipt, ...fields, phase };
          writeDesktopDisconnectReceipt(held, receipt, next); receipt = next;
        };
        advance("desktop_restored");
        advance("catalog_settled", { catalogAfter: { kind: "absent" } });
        advance("removing_token"); unlinkSync(serviceApiTokenFilePath());
        advance("token_removed"); advance("clearing_connection");
        expect(clearClientConnection(owner)).toBe("committed");
      }, fixtureLock());
    }
    const afterTransition = readFileSync(getConfigPath(), "utf8");
    release();
    expect(await pending).toBe(1);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(afterTransition);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(originalProfile);
    if (transition === "rotation") expect(loadConfig().client?.pendingOperation).toEqual(pendingRotation());
    else {
      expect(readClientConnectionState().kind).toBe("disconnected");
      expect(existsSync(serviceApiTokenFilePath())).toBe(false);
    }
  } finally { release(); await pending; build.mockRestore(); error.mockRestore(); warn.mockRestore(); }
});

test("local profile mutation preserves unrelated current settings after its builder await", async () => {
  connectDesktopFixture(false);
  const capturedState = await buildClaudeDesktopState(loadConfig());
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const build = spyOn(managementApi, "buildClaudeDesktopState").mockImplementation(async () => { entered(); await gate; return capturedState; });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const pending = handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet"]);
  try {
    await started;
    const latest = loadConfig();
    latest.port = 20202;
    latest.clientIntegrations = { ...latest.clientIntegrations, grok: false };
    saveConfig(latest);
    release();
    expect(await pending).toBe(0);
    expect(loadConfig().port).toBe(20202);
    expect(loadConfig().clientIntegrations?.grok).toBe(false);
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["mock/test-model"]?.family).toBe("sonnet");
  } finally { release(); await pending; build.mockRestore(); log.mockRestore(); warn.mockRestore(); }
});

test("connected show/export and local edits identify the local profile view", async () => {
  connectDesktopFixture(false);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).scope).toBe("local");
    const target = join(dir, "export.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8")).version).toBe(1);
    expect(await handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet"])).toBe(0);
    expect(await handleClaudeDesktopCommand(["default", "sonnet", "mock/test-model"])).toBe(0);
    expect(warn.mock.calls).toHaveLength(4);
    expect(warn.mock.calls.every(call => String(call[0]).includes("Local client profile only"))).toBe(true);
  } finally { log.mockRestore(); warn.mockRestore(); }
});

test("a disconnected hub retains local apply instead of downloading a remote snapshot", async () => {
  const config = loadConfig();
  config.runtimeRole = "hub";
  saveConfig(config);
  expect(readClientConnectionState().kind).toBe("disconnected");
  const deps: ApplyProfileDeps = {
    findLiveProxyImpl: async () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    postApplyImpl: async () => ({ ok: true, path: "/local-daemon" }),
    downloadDesktop3pModelsImpl: async () => { throw new Error("must not download for a disconnected hub"); },
  };
  expect(await applyProfile(undefined, "static", deps)).toMatchObject({ ok: true, path: "/local-daemon" });
  expect(loadConfig().claudeCode?.desktopProfile).toBeDefined();
});

test("show --json, move, default and export use the same persisted profile", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.profile.assignments["mock/test-model"].family).toBe("opus");

    expect(await handleClaudeDesktopCommand(["move", "mock/test-model", "sonnet", "--default"])).toBe(0);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const target = join(dir, "profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(exported.assignments["mock/test-model"].family).toBe("sonnet");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("import rejects invalid profiles without replacing saved state", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    await handleClaudeDesktopCommand(["move", "mock/test-model", "haiku", "--default"]);
    const before = structuredClone(loadConfig().claudeCode?.desktopProfile);
    const source = join(dir, "bad.json");
    writeFileSync(source, JSON.stringify({ version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } }));
    expect(await handleClaudeDesktopCommand(["import", source])).toBe(1);
    expect(loadConfig().claudeCode?.desktopProfile).toEqual(before);
    expect(error).toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("desktopNativeModels:false omits native/* from show and exported profile", async () => {
  saveConfig({
    port: 10100,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
    claudeCode: { desktopNativeModels: false },
  } as OcxConfig);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["show", "--json"])).toBe(0);
    const state = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(state.models.every((model: { route: string }) => !model.route.startsWith("native/"))).toBe(true);
    expect(Object.keys(state.profile.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);

    const target = join(dir, "desktop-profile.json");
    expect(await handleClaudeDesktopCommand(["export", target])).toBe(0);
    const exported = JSON.parse(readFileSync(target, "utf8"));
    expect(Object.keys(exported.assignments).every((route: string) => !route.startsWith("native/"))).toBe(true);
  } finally {
    log.mockRestore();
  }
});

/*
 * #859. The Desktop alias reverse-map is process-local to whichever process
 * builds it. When a live proxy exists, apply must run inside THAT process
 * through the management API; a local-only write leaves the serving daemon
 * unable to decode aliases and the provider 400s.
 */
test("apply delegates to the live proxy management API instead of writing locally", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const posted: Array<{ mode: string; profile: unknown }> = [];
  const result = await applyProfile(state.profile, "hybrid", {
    findLiveProxyImpl: async () => ({ pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" }),
    postApplyImpl: async (mode, profile) => {
      posted.push({ mode, profile });
      return { ok: true, path: "/daemon-side/path" };
    },
  });
  expect(posted.length).toBe(1);
  expect(posted[0]!.mode).toBe("hybrid");
  // The profile must cross the boundary; dropping it reintroduces #859's
  // stale-daemon variant.
  expect(posted[0]!.profile).toEqual(state.profile);
  expect(result.ok).toBe(true);
  expect(result.path).toBe("/daemon-side/path");
  // No local Desktop config write: the daemon performed it.
  expect(existsSync(join(dir, "desktop"))).toBe(false);
  // The CLI still persisted the profile itself.
  expect(loadConfig().claudeCode?.desktopProfile).toBeDefined();
});

test("apply writes locally only when no proxy is running", async () => {
  const state = await buildClaudeDesktopState(loadConfig());
  const result = await applyProfile(state.profile, "static", {
    findLiveProxyImpl: async () => null,
    postApplyImpl: async () => {
      throw new Error("must not be called without a live proxy");
    },
  });
  expect(result.ok).toBe(true);
  expect(existsSync(join(dir, "desktop"))).toBe(true);
});

test("no-arg and legacy mode flags apply Desktop config", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // Deterministic: no live proxy in the test environment, so apply writes locally.
    const noProxy = { findLiveProxyImpl: async () => null };
    expect(await handleClaudeDesktopCommand([], noProxy)).toBe(0);
    expect(await handleClaudeDesktopCommand(["--static"], noProxy)).toBe(0);
    expect(readFileSync(join(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!, "_meta.json"), "utf8")).toContain("opencodex");
    expect(error).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test("usage errors on desktop verbs exit 2, not 1", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await handleClaudeDesktopCommand(["status", "--wat"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["status", "extra"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["show", "--wat"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["move"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["nope"])).toBe(2);
    expect(await handleClaudeDesktopCommand(["apply", "--wat"])).toBe(2);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});
