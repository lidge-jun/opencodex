import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunner, SshChild, SshRunResult } from "../../src/link/ssh-runner";
import { trustedLoopbackForIngress, type ServerIngress } from "../../src/server/index/serve-options";

let temp = "";

function config(): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
}

function store(): LinkStore {
  return { version: 1, listenerPort: 18181, links: [] };
}

function supervisor(events: string[]): LinkSupervisor {
  return {
    start() {},
    ensureStarted: async () => { events.push("supervisor"); },
    reload: async () => { events.push("reload"); },
    stopLink: async () => {},
    status: () => [],
    stop: async () => {},
  };
}

function harness() {
  const cfg = config();
  let current = store();
  const callbacks = new Set<(id: string) => void>();
  const events: string[] = [];
  let listenerState: "off" | "listening" | "failed" = "listening";
  const listener = {
    ensureStarted: async () => { events.push("listener"); },
    status: () => ({ state: listenerState, port: listenerState === "listening" ? current.listenerPort : null, reason: listenerState === "failed" ? "bind" : null }),
    close: async () => { events.push("close"); },
    onAuthenticatedCatalog: (callback: (id: string) => void) => { callbacks.add(callback); return () => callbacks.delete(callback); },
  };
  const deps: ManagementApiDeps = {
    readLinkStore: () => current,
    writeLinkStore: next => { current = next; events.push("store"); },
    linkSupervisor: () => supervisor(events),
    linkListener: () => listener,
    linkKnownHostsPath: () => join(temp, "known_hosts"),
    issueApiKey: (cfg, name) => {
      const value = { id: `key-${cfg.apiKeys?.length ?? 0}`, name, key: "ocx_data_" + "a".repeat(40), createdAt: "2026-09-25T00:00:00.000Z" };
      cfg.apiKeys = [...(cfg.apiKeys ?? []), value];
      events.push("issue");
      return value;
    },
    revokeApiKey: (cfg, id) => {
      const before = cfg.apiKeys?.length ?? 0;
      cfg.apiKeys = (cfg.apiKeys ?? []).filter(key => key.id !== id);
      events.push("revoke");
      return before !== cfg.apiKeys.length;
    },
  };
  return { deps, config: cfg, events, listener, callbacks, setListenerState: (state: typeof listenerState) => { listenerState = state; }, get store() { return current; } };
}

function applyRunner(h: ReturnType<typeof harness>, connectCode = 0): SshRunner {
  return {
    async run(argv, options) {
      const text = argv.join(" ");
      if (text.includes("ssh-keygen")) return { code: 0, stdout: "256 SHA256:abcdefghijklmnop host (ED25519)", stderr: "" };
      const knownHostOption = argv.find(value => value.startsWith("UserKnownHostsFile="));
      if (knownHostOption) writeFileSync(knownHostOption.slice("UserKnownHostsFile=".length), "client ssh-ed25519 AAAA\n");
      if (text.includes("--version")) return { code: 0, stdout: "ocx 2.0.0\n", stderr: "" };
      if (text.includes("link' 'port")) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
      if (text.includes("connect")) {
        const raw = new TextDecoder().decode(options?.stdin as Uint8Array);
        const id = JSON.parse(raw).apiKeyId as string;
        for (const callback of h.callbacks) callback(id);
      }
      if (text.includes("connect")) return { code: connectCode, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
  };
}

async function call(path: string, method: string, body: unknown, deps: ManagementApiDeps, principal: "admin-token" | "gui-session" = "admin-token", trustedLoopback = true, issuance: import("../../src/server/gui-session").GuiSessionIssuance | null = null, paired = true, cfg?: OcxConfig) {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await handleManagementAPI(req, url, cfg ?? config(), deps, principal, { isPaired: () => paired, isCurrent: () => true, revokeCurrent: () => true }, { trustedLoopback, guiSessionIssuance: issuance });
  return response;
}

afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

describe("link management routes", () => {
  test("enforces dashboard, loopback admin, and Tailscale route principals", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-routes-"));
    const h = harness();
    expect((await call("/api/link/issue", "POST", { alias: "a", tunnelPort: 2200 }, h.deps, "admin-token", false, null, true, h.config))?.status).toBe(403);
    expect((await call("/api/link/issue", "POST", { alias: "a", tunnelPort: 2200 }, h.deps, "admin-token", true, "tailscale-identity", true, h.config))?.status).toBe(403);
    expect((await call("/api/link/candidates", "GET", undefined, h.deps, "admin-token", true, null, true, h.config))?.status).toBe(403);
    expect((await call("/api/link/candidates", "GET", undefined, h.deps, "gui-session", true, "pairing", false, h.config))?.status).toBe(403);
    expect((await call("/api/link/status", "GET", undefined, h.deps, "admin-token", true, null, true, h.config))?.status).toBe(200);
  });

  test("uses the serve-options trusted-loopback derivation for every ingress", () => {
    const ingresses: ServerIngress[] = ["public", "unauthenticated-loopback", "hub-management", "claude-intercept", "hub-link"];
    expect(ingresses.map(ingress => trustedLoopbackForIngress(ingress, "0.0.0.0"))).toEqual([false, true, false, false, false]);
    expect(trustedLoopbackForIngress("public", "127.0.0.1")).toBe(true);
    expect(trustedLoopbackForIngress("public", "::1")).toBe(true);
  });

  test("issues and force-revokes a client-initiated link with the K2/K16 DTOs", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-issue-"));
    const h = harness();
    const issued = await call("/api/link/issue", "POST", { alias: "home", tunnelPort: 2200 }, h.deps, "admin-token", true, null, true, h.config);
    expect(issued?.status).toBe(200);
    const issueBody = await issued!.json() as Record<string, unknown>;
    expect(Object.keys(issueBody).sort()).toEqual(["apiKeyId", "key", "linkId", "listenerPort"]);
    expect((await call(`/api/link/${issueBody.linkId}`, "DELETE", { force: true }, h.deps, "admin-token", true, null, true, h.config))?.status).toBe(200);
    expect(h.events).toContain("close");
  });

  test("rejects a duplicate live client-initiated alias", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-duplicate-client-"));
    const h = harness();
    expect((await call("/api/link/issue", "POST", { alias: "home", tunnelPort: 2200 }, h.deps, "admin-token", true, null, true, h.config))?.status).toBe(200);
    const duplicate = await call("/api/link/issue", "POST", { alias: "home", tunnelPort: 2201 }, h.deps, "admin-token", true, null, true, h.config);
    expect(duplicate?.status).toBe(409);
    expect(await duplicate!.json()).toMatchObject({ error: { code: "link_exists" } });
    expect(h.store.links).toHaveLength(1);
    expect(h.config.apiKeys).toHaveLength(1);
  });

  test("issue preserves a record written while the key is being issued", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-issue-race-"));
    const h = harness();
    const other = { id: "lnk_fedcba9876543210", alias: "other", direction: "client-initiated" as const, hostKeyFingerprint: null, tunnelPort: 2201, apiKeyId: "other-key", createdAt: "2026-09-25T00:00:00.000Z" };
    const issueApiKey = h.deps.issueApiKey!;
    const deps = {
      ...h.deps,
      issueApiKey: (cfg: OcxConfig, name: string) => {
        h.deps.writeLinkStore!({ ...h.store, links: [other] });
        return issueApiKey(cfg, name);
      },
    };
    expect((await call("/api/link/issue", "POST", { alias: "home", tunnelPort: 2200 }, deps, "admin-token", true, null, true, h.config))?.status).toBe(200);
    expect(h.store.links.map(link => link.alias)).toEqual(["other", "home"]);
  });

  test("apply preserves a record written while remote SSH connect waits", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-apply-race-"));
    const h = harness();
    const other = { id: "lnk_fedcba9876543210", alias: "other", direction: "client-initiated" as const, hostKeyFingerprint: null, tunnelPort: 2201, apiKeyId: "other-key", createdAt: "2026-09-25T00:00:00.000Z" };
    const baseRunner = applyRunner(h);
    const deps = {
      ...h.deps,
      sshRunner: {
        ...baseRunner,
        async run(argv: readonly string[], options?: { stdin?: string | Uint8Array }) {
          if (argv.join(" ").includes("connect")) h.deps.writeLinkStore!({ ...h.store, links: [other, ...h.store.links] });
          return baseRunner.run(argv, options);
        },
      },
    };
    expect((await call("/api/link/probe", "POST", { alias: "home" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "home", fingerprint: "SHA256:abcdefghijklmnop" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/apply", "POST", { alias: "home" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(202);
    expect(h.store.links.map(link => link.alias)).toEqual(["other", "home"]);
  });

  test("remove preserves a record written while remote disconnect waits", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-remove-race-"));
    const h = harness();
    const existing = { id: "lnk_0123456789abcdef", alias: "home", direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2200, apiKeyId: "key-1", createdAt: "2026-09-25T00:00:00.000Z" };
    const other = { id: "lnk_fedcba9876543210", alias: "other", direction: "client-initiated" as const, hostKeyFingerprint: null, tunnelPort: 2201, apiKeyId: "other-key", createdAt: "2026-09-25T00:00:00.000Z" };
    h.deps.writeLinkStore!({ ...h.store, links: [existing] });
    const runner: SshRunner = {
      async run() {
        h.deps.writeLinkStore!({ ...h.store, links: [existing, other] });
        return { code: 0, stdout: "", stderr: "" };
      },
      spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
    };
    expect((await call("/api/link/lnk_0123456789abcdef", "DELETE", {}, { ...h.deps, sshRunner: runner }, "admin-token", true, null, true, h.config))?.status).toBe(200);
    expect(h.store.links.map(link => link.alias)).toEqual(["other"]);
  });

  test("restarts a hub tunnel before reporting a failed remote disconnect", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-disconnect-failed-"));
    const h = harness();
    h.deps.writeLinkStore!({ ...h.store, links: [{
      id: "lnk_0123456789abcdef",
      alias: "home",
      direction: "hub-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2200,
      apiKeyId: "key-1",
      createdAt: "2026-09-25T00:00:00.000Z",
    }] });
    const runner: SshRunner = {
      async run() { return { code: 1, stdout: "", stderr: "disconnect failed" }; },
      spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
    };
    const response = await call("/api/link/lnk_0123456789abcdef", "DELETE", {}, { ...h.deps, sshRunner: runner }, "admin-token", true, null, true, h.config);
    expect(response?.status).toBe(502);
    expect(await response!.json()).toMatchObject({ error: { code: "remote_disconnect_failed" } });
    expect(h.events).toContain("reload");
    expect(h.store.links).toHaveLength(1);
  });

  test("rejects issue when ensureStarted leaves the listener failed and compensates", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-listener-failed-"));
    const h = harness();
    h.setListenerState("failed");
    const response = await call("/api/link/issue", "POST", { alias: "failed-listener", tunnelPort: 2200 }, h.deps, "admin-token", true, null, true, h.config);
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ error: { code: "listener_unavailable" } });
    expect(h.store.links).toHaveLength(0);
    expect(h.config.apiKeys).toEqual([]);
    expect(h.events).toContain("close");
  });

  test("returns listener_unavailable from apply and closes after successful compensation", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-apply-listener-failed-"));
    const h = harness();
    const deps = { ...h.deps, sshRunner: applyRunner(h) };
    expect((await call("/api/link/probe", "POST", { alias: "failed-apply" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "failed-apply", fingerprint: "SHA256:abcdefghijklmnop" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    h.setListenerState("failed");
    const response = await call("/api/link/apply", "POST", { alias: "failed-apply" }, deps, "gui-session", true, "pairing", true, h.config);
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ error: { code: "listener_unavailable" } });
    expect(h.store.links).toHaveLength(0);
    expect(h.config.apiKeys).toEqual([]);
    expect(h.events).toContain("close");
  });

  test("retains an apply record when remote failure revocation fails", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-apply-revoke-failed-"));
    const h = harness();
    const deps = { ...h.deps, sshRunner: applyRunner(h, 1), revokeApiKey: () => false };
    expect((await call("/api/link/probe", "POST", { alias: "remote-failed" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "remote-failed", fingerprint: "SHA256:abcdefghijklmnop" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    const response = await call("/api/link/apply", "POST", { alias: "remote-failed" }, deps, "gui-session", true, "pairing", true, h.config);
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ error: { code: "compensation_failed" } });
    expect(h.store.links).toHaveLength(1);
    const status = await call("/api/link/status", "GET", undefined, deps, "gui-session", true, "pairing", true, h.config);
    expect((await status!.json()).links[0]).toMatchObject({ state: "failed", reason: "compensation_failed" });
  });

  test("revokes an issued key when the initial link store write fails", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-store-write-failed-"));
    const h = harness();
    const deps = { ...h.deps, writeLinkStore: () => { throw new Error("store write failed"); } };
    const response = await call("/api/link/issue", "POST", { alias: "write-failed", tunnelPort: 2200 }, deps, "admin-token", true, null, true, h.config);
    expect(response?.status).toBe(503);
    expect(await response!.json()).toMatchObject({ error: { code: "link_issue_failed" } });
    expect(h.config.apiKeys).toEqual([]);
    expect(h.store.links).toHaveLength(0);
  });

  test("retains and marks a link when cleanup store write fails after revocation", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-cleanup-write-failed-"));
    const h = harness();
    let writes = 0;
    const deps = {
      ...h.deps,
      writeLinkStore: (next: LinkStore) => {
        writes += 1;
        if (writes === 2) throw new Error("cleanup write failed");
        h.deps.writeLinkStore!(next);
      },
    };
    h.setListenerState("failed");
    const response = await call("/api/link/issue", "POST", { alias: "cleanup-failed", tunnelPort: 2200 }, deps, "admin-token", true, null, true, h.config);
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ error: { code: "compensation_failed" } });
    expect(h.store.links).toHaveLength(1);
    expect(h.config.apiKeys).toEqual([]);
    const status = await call("/api/link/status", "GET", undefined, deps, "admin-token", true, null, true, h.config);
    expect((await status!.json()).links[0]).toMatchObject({ state: "failed", reason: "compensation_failed" });
    // The key is already gone, so a retried removal must finish instead of failing on it forever.
    const linkId = h.store.links[0]!.id;
    const retry = await call(`/api/link/${linkId}`, "DELETE", { force: true }, h.deps, "admin-token", true, null, true, h.config);
    expect(retry?.status).toBe(200);
    expect(h.store.links).toEqual([]);
    const after = await call("/api/link/status", "GET", undefined, h.deps, "admin-token", true, null, true, h.config);
    expect((await after!.json()).links).toEqual([]);
  });

  test("returns compensation_failed and retains the record when duplicate revoke fails", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-duplicate-compensation-"));
    const h = harness();
    const existing = { id: "lnk_0123456789abcdef", alias: "duplicate", direction: "hub-initiated" as const, hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2200, apiKeyId: "existing-key", createdAt: "2026-09-25T00:00:00.000Z" };
    h.deps.writeLinkStore!({ ...h.store, links: [existing] });
    const deps = { ...h.deps, revokeApiKey: () => false };
    const runner: SshRunner = {
      async run(argv) {
        const text = argv.join(" ");
        if (text.includes("ssh-keygen")) return { code: 0, stdout: "256 SHA256:abcdefghijklmnop host (ED25519)", stderr: "" };
        const knownHostOption = argv.find(value => value.startsWith("UserKnownHostsFile="));
        if (knownHostOption) writeFileSync(knownHostOption.slice("UserKnownHostsFile=".length), "client ssh-ed25519 AAAA\n");
        if (text.includes("--version")) return { code: 0, stdout: "ocx 2.0.0\n", stderr: "" };
        if (text.includes("link' 'port")) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
    };
    const routed = { ...deps, sshRunner: runner };
    expect((await call("/api/link/probe", "POST", { alias: "duplicate" }, routed, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "duplicate", fingerprint: "SHA256:abcdefghijklmnop" }, routed, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    const response = await call("/api/link/apply", "POST", { alias: "duplicate" }, routed, "gui-session", true, "pairing", true, h.config);
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ error: { code: "compensation_failed" } });
    expect(h.store.links).toHaveLength(2);
    const status = await call("/api/link/status", "GET", undefined, routed, "gui-session", true, "pairing", true, h.config);
    expect((await status!.json()).links.at(-1)).toMatchObject({ state: "failed", reason: "compensation_failed" });
  });

  test("apply observes command exit and first authenticated catalog admission", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-apply-"));
    const h = harness();
    const runner: SshRunner = {
      async run(argv: readonly string[], options?: { stdin?: string | Uint8Array }): Promise<SshRunResult> {
        const text = argv.join(" ");
        if (text.includes("ssh-keygen")) return { code: 0, stdout: "256 SHA256:abcdefghijklmnop host (ED25519)", stderr: "" };
        const knownHostOption = argv.find(value => value.startsWith("UserKnownHostsFile="));
        if (knownHostOption) writeFileSync(knownHostOption.slice("UserKnownHostsFile=".length), "client ssh-ed25519 AAAA\n");
        if (text.includes("--version")) return { code: 0, stdout: "ocx 2.0.0\n", stderr: "" };
        if (text.includes("connect")) {
          h.events.push("connect");
          const raw = typeof options?.stdin === "string" ? options.stdin : new TextDecoder().decode(options?.stdin);
          const id = JSON.parse(raw ?? "{}").apiKeyId as string;
          for (const callback of h.callbacks) callback(id);
        }
        if (text.includes("link' 'port")) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      spawnTunnel: (_argv: readonly string[]): SshChild => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
    };
    const deps = { ...h.deps, sshRunner: runner };
    const probed = await call("/api/link/probe", "POST", { alias: "client" }, deps, "gui-session", true, "pairing", true, h.config);
    expect(probed?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "client", fingerprint: "SHA256:abcdefghijklmnop" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/apply", "POST", { alias: "client" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(202);
    expect(h.events.indexOf("reload")).toBeGreaterThan(-1);
    expect(h.events.indexOf("reload")).toBeLessThan(h.events.findIndex(event => event === "connect"));
  });
});
