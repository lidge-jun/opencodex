import { removeDesktop3pStandardPivot, writeDesktop3pConfig } from "../../src/claude/desktop-3p";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as configIO from "../../src/config";
import { saveConfig, loadConfig, readConfigDiagnostics, atomicWriteFile } from "../../src/config";
import { withClientLifecycleSync, type ClientLifecycleHeld } from "../../src/client/lifecycle-lock";
import { serviceApiTokenFingerprint, writeServiceApiTokenFile, replaceServiceApiTokenFile, writeTokenBackup, serviceApiTokenBackupPath, removeServiceApiTokenFileIfOwned } from "../../src/lib/service-secrets";
import {
  applyRemoteDesktopStore, replaceRemoteDesktopCredential, restoreRemoteDesktopStore, finishRemoteDesktopCleanup,
  inspectRemoteDesktopStore, inspectRemoteDesktopCleanup, readDesktopDisconnectReceipt, writeDesktopDisconnectReceipt,
  type DesktopDisconnectReceipt, type DesktopRemoteOwner,
} from "../../src/claude/desktop-remote-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const owner: DesktopRemoteOwner = { serverUrl: "https://hub.example.test", apiKeyId: "fixture-key", connectedAt: "2026-09-06T00:00:00.000Z" };
const token = "ocx_data_store_fixture_current";
const fingerprint = serviceApiTokenFingerprint(token);
const hash = (text: string) => serviceApiTokenFingerprint(text);
let dir: string, library: string, previousHome: string | undefined, previousLibrary: string | undefined;
function locked<T>(work: (held: ClientLifecycleHeld) => T): T {
  return withClientLifecycleSync(work, { lockPath: join(dir, "locks", "lifecycle.sqlite") });
}
function read(path: string): Record<string, unknown> { return JSON.parse(readFileSync(path, "utf8")); }
function profile() { return read(join(library, "original.json")); }
function initial(value: Record<string, unknown>, selected = "original"): void {
  atomicWriteFile(join(library, "original.json"), JSON.stringify(value));
  atomicWriteFile(join(library, "foreign.json"), JSON.stringify({ foreign: true }));
  atomicWriteFile(join(library, "_meta.json"), JSON.stringify({
    appliedId: selected, customMetadata: "keep", entries: [{ id: "original", name: "opencodex", custom: true }, { id: "foreign", name: "Personal" }],
  }));
}
function remote(key = token) {
  return { inferenceProvider: "gateway", inferenceCredentialKind: "static", inferenceGatewayBaseUrl: owner.serverUrl,
    inferenceGatewayApiKey: key, modelDiscoveryEnabled: false, inferenceModels: [], custom: "preserved" };
}
function apply() {
  return locked(held => applyRemoteDesktopStore(held, {
    owner, expectedTokenFingerprint: fingerprint, baseUrl: owner.serverUrl, apiKey: token, mode: "static",
    models: [{ name: "claude-opus-4-8-20260304", labelOverride: "Fixture", anthropicFamilyTier: "fable" }],
  }));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocx-desktop-store-")));
  library = join(dir, "desktop");
  process.env.OPENCODEX_HOME = join(dir, "ocx");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  saveConfig({ port: 10100, defaultProvider: "test", providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, runtimeRole: "client", client: {
    ...owner, managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: ["claude"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN", tokenFingerprint: fingerprint, protocolVersion: 1,
  } } as OcxConfig);
  writeServiceApiTokenFile(token);
  expect(readConfigDiagnostics().source).toBe("file");
  expect(loadConfig().client?.apiKeyId).toBe(owner.apiKeyId);
  // Only the fixture creates its Desktop root; read-only store calls never do.
  mkdirSync(library, { recursive: true });
});


afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR; else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousLibrary;
  removeTreeWithRetry(dir);
});

describe("connection-owned Desktop projection store", () => {
  test("facade dependencies use the real fixture lock and release it before the next call", () => {
    const config = loadConfig(); delete config.client; config.runtimeRole = "standalone"; saveConfig(config);
    initial({ custom: true });
    const deps = { lockPath: join(dir, "locks", "facade.sqlite") };
    const before = hash(readFileSync(join(library, "original.json"), "utf8"));
    withClientLifecycleSync(() => {
      expect(writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, deps).written).toBe(false);
      expect(removeDesktop3pStandardPivot({ lifecycleLockDeps: deps }).ok).toBe(false);
      expect(hash(readFileSync(join(library, "original.json"), "utf8"))).toBe(before);
    }, deps);
    expect(writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, deps).written).toBe(true);
    config.clientIntegrations = { "claude-desktop": false }; saveConfig(config);
    expect(removeDesktop3pStandardPivot({ lifecycleLockDeps: deps }).ok).toBe(true);
  });

  test("local facade mutations respect the fresh opposite desired state", () => {
    const config = loadConfig(); delete config.client; config.runtimeRole = "standalone";
    config.clientIntegrations = { "claude-desktop": true }; saveConfig(config);
    initial(remote());
    const before = hash(readFileSync(join(library, "original.json"), "utf8"));
    const beforeMeta = hash(readFileSync(join(library, "_meta.json"), "utf8"));
    const deps = { lockPath: join(dir, "locks", "desired.sqlite") };
    expect(removeDesktop3pStandardPivot({ lifecycleLockDeps: deps })).toMatchObject({ ok: false, changed: false, reason: "desired_state_changed" });
    config.clientIntegrations = { "claude-desktop": false }; saveConfig(config);
    expect(writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, deps)).toMatchObject({ written: false, reason: "desired_state_changed" });
    expect(hash(readFileSync(join(library, "original.json"), "utf8"))).toBe(before);
    expect(hash(readFileSync(join(library, "_meta.json"), "utf8"))).toBe(beforeMeta);
  });

  test("invalid or mismatched client config cannot fall back to local facade mutation", () => {
    initial(remote());
    const before = hash(readFileSync(join(library, "original.json"), "utf8"));
    const beforeMeta = hash(readFileSync(join(library, "_meta.json"), "utf8"));
    const deps = { lockPath: join(dir, "locks", "facade.sqlite") };
    for (const malformed of [
      { runtimeRole: "client", client: {} },
      { runtimeRole: "client" },
      { runtimeRole: "standalone", client: {} },
    ]) {
      atomicWriteFile(join(dir, "ocx", "config.json"), JSON.stringify(malformed));
      expect(removeDesktop3pStandardPivot({ lifecycleLockDeps: deps })).toMatchObject({ ok: false, changed: false, kind: "unsafe" });
      expect(writeDesktop3pConfig(10100, [], [], undefined, "static", undefined, undefined, deps).written).toBe(false);
      expect(hash(readFileSync(join(library, "original.json"), "utf8"))).toBe(before);
      expect(hash(readFileSync(join(library, "_meta.json"), "utf8"))).toBe(beforeMeta);
    }
  });

  test("forged lease rejects before creating storage; unused inspect has no footprint", () => {
    expect(inspectRemoteDesktopStore(owner).kind).toBe("absent");
    expect(() => restoreRemoteDesktopStore({} as ClientLifecycleHeld, { owner, knownTokenFingerprints: [fingerprint] })).toThrow("client_lifecycle_lease_invalid");
    expect(existsSync(join(dir, "ocx", "desktop-remote"))).toBe(false);
  });

  test("keeps first local baseline across apply and preserves later foreign fields/selection on restore", () => {
    initial({ ...remote("local-profile-key"), inferenceGatewayBaseUrl: "http://127.0.0.1:10100", custom: "old" });
    expect(apply().ok).toBe(true);
    const baselinePath = join(dir, "ocx", "desktop-remote", "baseline.json");
    const originalBaselineHash = hash(readFileSync(baselinePath, "utf8"));
    if (process.platform !== "win32") expect(statSync(baselinePath).mode & 0o777).toBe(0o600);
    expect(apply().ok).toBe(true);
    expect(hash(readFileSync(baselinePath, "utf8"))).toBe(originalBaselineHash);
    const current = profile(); current.custom = "new-user-value"; atomicWriteFile(join(library, "original.json"), JSON.stringify(current));
    const meta = read(join(library, "_meta.json")); meta.appliedId = "foreign"; meta.newForeignMetadata = true;
    atomicWriteFile(join(library, "_meta.json"), JSON.stringify(meta));
    const restored = locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] }));
    expect(restored).toMatchObject({ ok: true, status: "restored", restoration: "selection_preserved" });
    expect(hash(String(profile().inferenceGatewayApiKey))).toBe(hash("local-profile-key"));
    expect(profile().custom).toBe("new-user-value");
    expect(read(join(library, "_meta.json")).appliedId).toBe("foreign");
    expect(read(join(library, "_meta.json")).newForeignMetadata).toBe(true);
    expect(existsSync(join(library, "original.json.bak"))).toBe(false);
  });

  test("legacy direct disconnect creates a labeled standard fallback and sanitizes known-key backup", () => {
    initial(remote());
    atomicWriteFile(join(library, "original.json.bak"), JSON.stringify(remote()));
    expect(inspectRemoteDesktopStore(owner).kind).toBe("legacy_current_connection");
    const result = locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] }));
    expect(result).toMatchObject({ ok: true, baselineKind: "standard_fallback", restoration: "standard_fallback" });
    expect(profile().inferenceProvider).toBeUndefined();
    expect(profile().custom).toBe("preserved");
    expect(read(join(library, "original.json.bak")).inferenceGatewayApiKey).toBeUndefined();
    const baseline = readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8");
    const state = readFileSync(join(dir, "ocx", "desktop-remote", "state.json"), "utf8");
    expect(baseline.includes(token)).toBe(false);
    expect(state.includes(token)).toBe(false);
    expect(read(join(library, "_meta.json")).appliedId).toBe("original");
  });

  test("rotation changes only the key and keeps fallback baseline immutable", () => {
    initial(remote());
    expect(apply().ok).toBe(true);
    const baseline = hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"));
    const before = profile(); const beforeMeta = hash(readFileSync(join(library, "_meta.json"), "utf8"));
    writeTokenBackup(fingerprint);
    const replacementKey = "ocx_data_store_fixture_replacement";
    const pending = loadConfig();
    pending.client!.pendingOperation = { kind: "rotate", rotationId: "fixture-rotation", newKeyIssuedAt: owner.connectedAt, oldKeyBackupPath: serviceApiTokenBackupPath() };
    saveConfig(pending);
    replaceServiceApiTokenFile(replacementKey);
    const updated = locked(held => replaceRemoteDesktopCredential(held, { owner, expectedTokenFingerprint: fingerprint, replacementKey }));
    expect(updated.ok).toBe(true);
    const after = profile();
    expect(hash(String(after.inferenceGatewayApiKey))).toBe(hash(replacementKey));
    delete before.inferenceGatewayApiKey; delete after.inferenceGatewayApiKey;
    expect(after).toEqual(before);
    expect(hash(readFileSync(join(library, "_meta.json"), "utf8"))).toBe(beforeMeta);
    expect(hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"))).toBe(baseline);
    expect(existsSync(join(library, "original.json.bak"))).toBe(false);
    replaceServiceApiTokenFile(token);
    const rollback = locked(held => replaceRemoteDesktopCredential(held, { owner, expectedTokenFingerprint: hash(replacementKey), replacementKey: token }));
    expect(rollback.ok).toBe(true);
    expect(hash(String(profile().inferenceGatewayApiKey))).toBe(fingerprint);
  });

  test("managed edits and missing committed baseline fail closed", () => {
    initial({ custom: true }); expect(apply().ok).toBe(true);
    const changed = profile(); changed.inferenceGatewayBaseUrl = "https://other.example.test";
    atomicWriteFile(join(library, "original.json"), JSON.stringify(changed));
    const before = hash(readFileSync(join(library, "original.json"), "utf8"));
    expect(locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] }))).toMatchObject({ ok: false, reason: "conflict" });
    expect(hash(readFileSync(join(library, "original.json"), "utf8"))).toBe(before);
    writeFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "{}", { mode: 0o600 });
    expect(inspectRemoteDesktopCleanup().kind).toBe("unsafe");
  });

  test("replays a profile-written metadata-failed apply without replacing the first baseline", () => {
    initial({ custom: true }, "foreign");
    const realWrite = configIO.atomicWriteFile;
    const failure = spyOn(configIO, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
      if (path === join(library, "_meta.json")) throw new Error("injected metadata failure");
      return realWrite(path, content, io, hooks);
    });
    try { expect(apply()).toMatchObject({ ok: false, changed: true, reason: "recovery_required" }); }
    finally { failure.mockRestore(); }
    const baseline = hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"));
    expect(apply().ok).toBe(true);
    expect(read(join(library, "_meta.json")).appliedId).toBe("original");
    expect(hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"))).toBe(baseline);
  });

  test("direct restore retains new-target creation evidence after metadata failures", () => {
    atomicWriteFile(join(library, "foreign.json"), JSON.stringify({ foreign: "preserve" }));
    atomicWriteFile(join(library, "_meta.json"), JSON.stringify({
      appliedId: "foreign", entries: [{ id: "foreign", name: "Personal" }], foreignMetadata: true,
    }));
    const realWrite = configIO.atomicWriteFile;
    const failMetadata = () => spyOn(configIO, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
      if (path === join(library, "_meta.json")) throw new Error("injected new-row metadata failure");
      return realWrite(path, content, io, hooks);
    });
    const applyFailure = failMetadata();
    try { expect(apply()).toMatchObject({ ok: false, changed: true, reason: "recovery_required" }); }
    finally { applyFailure.mockRestore(); }
    const statePath = join(dir, "ocx", "desktop-remote", "state.json");
    const interrupted = read(statePath);
    const targetId = String(interrupted.targetId);
    const targetPath = join(library, `${targetId}.json`);
    expect(existsSync(targetPath)).toBe(true);
    expect((read(join(library, "_meta.json")).entries as Array<{ id: string }>).some(entry => entry.id === targetId)).toBe(false);
    const baselineHash = hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"));
    const receipt: DesktopDisconnectReceipt = { version: 1, owner, tokenFingerprint: fingerprint, keepCatalog: false, phase: "prepared" };
    locked(held => writeDesktopDisconnectReceipt(held, null, receipt));
    // A real prepared disconnect already bars reapply; recovery must use restore.
    expect(apply()).toMatchObject({ ok: false, reason: "conflict" });
    const restoreFailure = failMetadata();
    try {
      expect(locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] })))
        .toMatchObject({ ok: false, changed: true, reason: "recovery_required" });
    } finally { restoreFailure.mockRestore(); }
    expect((read(statePath).pending as { kind: string }).kind).toBe("restore");
    expect(read(statePath).lastProjectionHash).toBe(interrupted.lastProjectionHash);
    expect(read(targetPath).inferenceGatewayApiKey).toBeUndefined();
    expect(locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] })))
      .toMatchObject({ ok: true, status: "restored", restoration: "selection_preserved" });
    expect(read(statePath).pending).toBeUndefined();
    expect(inspectRemoteDesktopStore(owner).kind).toBe("restored");
    expect(read(join(library, "_meta.json")).appliedId).toBe("foreign");
    expect(read(join(library, "_meta.json")).foreignMetadata).toBe(true);
    expect(hash(readFileSync(join(dir, "ocx", "desktop-remote", "baseline.json"), "utf8"))).toBe(baselineHash);
  });

  test.each([false, true])("metadata capacity permits only an existing owned target (reuse=%s)", reuseOwned => {
    const entries = Array.from({ length: 256 }, (_, index) => ({
      id: `entry-${index}`, name: reuseOwned && index === 0 ? "opencodex" : `Personal ${index}`,
    }));
    for (const entry of entries) writeFileSync(join(library, `${entry.id}.json`), JSON.stringify({ foreign: entry.id }));
    atomicWriteFile(join(library, "_meta.json"), JSON.stringify({ appliedId: "entry-0", entries }));
    const beforeMeta = hash(readFileSync(join(library, "_meta.json"), "utf8"));
    const beforeTarget = hash(readFileSync(join(library, "entry-0.json"), "utf8"));
    const files = readdirSync(library).sort();
    const result = apply();
    expect(result.ok).toBe(reuseOwned);
    expect((read(join(library, "_meta.json")).entries as unknown[]).length).toBe(256);
    expect(readdirSync(library).sort()).toEqual(files);
    if (reuseOwned) {
      expect(hash(String(read(join(library, "entry-0.json")).inferenceGatewayApiKey))).toBe(fingerprint);
      expect(inspectRemoteDesktopStore(owner).kind).toBe("active");
    } else {
      expect(result).toMatchObject({ ok: false, changed: false, reason: "conflict" });
      expect(hash(readFileSync(join(library, "_meta.json"), "utf8"))).toBe(beforeMeta);
      expect(hash(readFileSync(join(library, "entry-0.json"), "utf8"))).toBe(beforeTarget);
      expect(existsSync(join(dir, "ocx", "desktop-remote", "baseline.json"))).toBe(false);
      expect(existsSync(join(dir, "ocx", "desktop-remote", "state.json"))).toBe(false);
    }
  });

  test.each([false, true])("connected remover refuses another library before remote mutation (tracked=%s)", tracked => {
    initial(remote());
    if (tracked) expect(apply().ok).toBe(true);
    const otherLibrary = join(dir, "other-desktop");
    mkdirSync(otherLibrary, { recursive: true });
    atomicWriteFile(join(otherLibrary, "other.json"), JSON.stringify(remote()));
    atomicWriteFile(join(otherLibrary, "_meta.json"), JSON.stringify({ appliedId: "other", entries: [{ id: "other", name: "opencodex" }] }));
    const config = loadConfig(); config.clientIntegrations = { "claude-desktop": false }; saveConfig(config);
    const paths = [join(library, "original.json"), join(library, "_meta.json"), join(otherLibrary, "other.json"), join(otherLibrary, "_meta.json")];
    const before = paths.map(path => hash(readFileSync(path, "utf8")));
    const statePath = join(dir, "ocx", "desktop-remote", "state.json");
    const beforeState = existsSync(statePath) ? hash(readFileSync(statePath, "utf8")) : null;
    const result = removeDesktop3pStandardPivot({
      env: { ...process.env, OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: otherLibrary },
      lifecycleLockDeps: { lockPath: join(dir, "locks", "mismatch.sqlite") },
    });
    expect(result).toMatchObject({ ok: false, changed: false, reason: "desktop_library_identity_changed" });
    expect(paths.map(path => hash(readFileSync(path, "utf8")))).toEqual(before);
    expect(existsSync(statePath) ? hash(readFileSync(statePath, "utf8")) : null).toBe(beforeState);
  });

  test("invalid remote entries fail before storing any baseline or rewriting the profile", () => {
    initial({ custom: true });
    const before = hash(readFileSync(join(library, "original.json"), "utf8"));
    const result = locked(held => applyRemoteDesktopStore(held, {
      owner, expectedTokenFingerprint: fingerprint, baseUrl: owner.serverUrl, apiKey: token, mode: "static",
      models: [{ name: "invalid", labelOverride: "Fixture", anthropicFamilyTier: "opus" }],
    }));
    expect(result).toMatchObject({ ok: false, changed: false, reason: "unsafe" });
    expect(hash(readFileSync(join(library, "original.json"), "utf8"))).toBe(before);
    expect(existsSync(join(dir, "ocx", "desktop-remote", "baseline.json"))).toBe(false);
  });

  test("unsafe metadata IDs and duplicate rows never create a baseline", () => {
    initial(remote());
    const metaPath = join(library, "_meta.json");
    const meta = read(metaPath);
    meta.entries = [{ id: "original", name: "opencodex" }, { id: "original", name: "Other" }];
    atomicWriteFile(metaPath, JSON.stringify(meta));
    expect(apply()).toMatchObject({ ok: false, reason: "unsafe" });
    expect(existsSync(join(dir, "ocx", "desktop-remote", "baseline.json"))).toBe(false);
    meta.appliedId = "../escape"; meta.entries = [{ id: "../escape", name: "opencodex" }];
    atomicWriteFile(metaPath, JSON.stringify(meta));
    expect(inspectRemoteDesktopStore(owner).kind).toBe("unsafe");
  });

  test("an interrupted prepared baseline can resume only while original bytes still match", () => {
    initial({ custom: true });
    const realWrite = configIO.atomicWriteFile;
    const failure = spyOn(configIO, "atomicWriteFile").mockImplementation((path, content, io, hooks) => {
      if (path.endsWith("/desktop-remote/baseline.json") || path.endsWith("\\desktop-remote\\baseline.json")) throw new Error("injected baseline failure");
      return realWrite(path, content, io, hooks);
    });
    try { expect(apply()).toMatchObject({ ok: false, changed: true }); }
    finally { failure.mockRestore(); }
    expect(inspectRemoteDesktopStore(owner).kind).toBe("pending");
    expect(profile().inferenceProvider).toBeUndefined();
    expect(apply().ok).toBe(true);
    expect(inspectRemoteDesktopStore(owner).kind).toBe("active");
  });

  test("receipt CAS and final cleanup require actual disconnected state and absent token", () => {
    initial(remote()); expect(apply().ok).toBe(true);
    const first: DesktopDisconnectReceipt = { version: 1, owner, tokenFingerprint: fingerprint, keepCatalog: false, phase: "prepared" };
    locked(held => writeDesktopDisconnectReceipt(held, null, first));
    expect(() => locked(held => writeDesktopDisconnectReceipt(held, null, first))).toThrow("desktop_disconnect_receipt_conflict");
    expect(locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [fingerprint] })).ok).toBe(true);
    let current = first;
    for (const phase of ["desktop_restored", "catalog_settled", "removing_token", "token_removed", "clearing_connection", "connection_cleared"] as const) {
      const next = { ...current, phase };
      locked(held => writeDesktopDisconnectReceipt(held, current, next)); current = next;
    }
    expect(locked(held => finishRemoteDesktopCleanup(held, owner)).ok).toBe(false);
    removeServiceApiTokenFileIfOwned(fingerprint);
    const config = loadConfig(); delete config.client; config.runtimeRole = "standalone"; saveConfig(config);
    expect(locked(held => finishRemoteDesktopCleanup(held, owner)).ok).toBe(true);
    expect(existsSync(join(dir, "ocx", "desktop-remote", "baseline.json"))).toBe(false);
    expect(inspectRemoteDesktopCleanup().kind).toBe("pending");
    const complete = { ...current, phase: "complete" as const };
    locked(held => writeDesktopDisconnectReceipt(held, current, complete));
    expect(readDesktopDisconnectReceipt()).toMatchObject({ kind: "valid", value: { phase: "complete" } });
    expect(inspectRemoteDesktopCleanup().kind).toBe("absent");
  });
});
