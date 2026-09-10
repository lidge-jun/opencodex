import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRemoteControlIdentityKeyPair } from "../../src/remote-control/crypto";
import { RemoteWorkspaceHubFileStore } from "../../src/remote-control/workspace-hub";
import { RemoteWorkspaceDeviceFileStore } from "../../src/remote-control/workspace-device";
import { RemoteWorkspaceSessionFileStore } from "../../src/remote-control/workspace-sessions";
import { workspaceSecretPermissions, type WorkspaceSecretPermissions } from "../../src/remote-control/workspace-secret-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const roots: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixtures() {
  const root = mkdtempSync(join(tmpdir(), "ocx-workspace-secret-"));
  roots.push(root);
  process.env.OPENCODEX_HOME = root;
  const identity = generateRemoteControlIdentityKeyPair();
  const hubState = { version: 1 as const, identity, devices: [] };
  const sessionState = { version: 1 as const, sessions: [] };
  const deviceState = {
    version: 1 as const, hubUrl: "https://hub.example.test",
    agentUrl: "wss://hub.example.test/remote-workspace/agent",
    deviceId: randomUUID(), deviceName: "Executor", devicePlatform: "test",
    capabilities: ["workspace.read" as const], deviceToken: `ocxrw_${"A".repeat(43)}`,
    deviceIdentity: identity, hubPublicKey: identity.publicKey,
    roots: [{ id: randomUUID(), label: "Project", path: root }], toolchainRoots: [],
  };
  return [
    { path: join(root, "hub.json"), create: (p: string, permissions?: WorkspaceSecretPermissions) => {
      const store = new RemoteWorkspaceHubFileStore(p, permissions);
      return { load: () => store.load(), save: () => store.save(hubState) };
    } },
    { path: join(root, "device.json"), create: (p: string, permissions?: WorkspaceSecretPermissions) => {
      const store = new RemoteWorkspaceDeviceFileStore(p, permissions);
      return { load: () => store.load(), save: () => store.save(deviceState) };
    } },
    { path: join(root, "sessions.json"), create: (p: string, permissions?: WorkspaceSecretPermissions) => {
      const store = new RemoteWorkspaceSessionFileStore(p, permissions);
      return { load: () => store.load(), save: () => store.save(sessionState) };
    } },
  ];
}

test("all workspace stores distinguish absent state from permission failure", () => {
  for (const fixture of fixtures()) {
    const store = fixture.create(fixture.path);
    expect(store.load()).toBeNull();
    store.save();
    expect(store.load()).not.toBeNull();
    if (process.platform !== "win32") expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
  }
});

test("all stores propagate hardening failures before decoding or publishing secret bytes", () => {
  for (const fixture of fixtures()) {
    for (const failedStep of ["prepareDirectory", "hardenFile"] as const) {
      // Invalid JSON would fail if read reached decoding instead of the permission boundary.
      writeFileSync(fixture.path, "private-sentinel-not-json", { mode: 0o600 });
      const calls: string[] = [];
      const permissions: WorkspaceSecretPermissions = {
        prepareDirectory() { calls.push("directory"); if (failedStep === "prepareDirectory") throw new Error("denied hardening"); },
        hardenFile() { calls.push("file"); throw new Error("denied hardening"); },
      };
      const store = fixture.create(fixture.path, permissions);
      expect(() => store.load()).toThrow("denied hardening");
      expect(() => store.save()).toThrow("denied hardening");
      expect(readFileSync(fixture.path, "utf8")).toBe("private-sentinel-not-json");
      expect(calls).toEqual(failedStep === "prepareDirectory"
        ? ["directory", "directory"] : ["directory", "file", "directory", "file"]);
    }
  }
});

test("secret files refuse symbolic-link targets", () => {
  if (process.platform === "win32") return; // Windows link creation requires separate privileges.
  const fixture = fixtures()[0]!;
  const target = `${fixture.path}.target`;
  writeFileSync(target, "private", { mode: 0o600 });
  symlinkSync(target, fixture.path);
  expect(() => workspaceSecretPermissions.hardenFile(fixture.path)).toThrow("regular file");
  expect(readFileSync(target, "utf8")).toBe("private");
});


test("an inaccessible existing store is never reported as first-run absence", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  for (const fixture of fixtures()) {
    const store = fixture.create(fixture.path);
    store.save();
    const before = readFileSync(fixture.path, "utf8");
    const directory = fixture.path.slice(0, fixture.path.lastIndexOf("/"));
    chmodSync(directory, 0);
    try { expect(() => store.load()).toThrow(); }
    finally { chmodSync(directory, 0o700); }
    expect(readFileSync(fixture.path, "utf8")).toBe(before);
  }
});
