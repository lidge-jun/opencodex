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
  const listener = {
    ensureStarted: async () => { events.push("listener"); },
    status: () => ({ state: "listening" as const, port: current.listenerPort, reason: null }),
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
  return { deps, config: cfg, events, listener, callbacks, get store() { return current; } };
}

async function call(path: string, method: string, body: unknown, deps: ManagementApiDeps, principal: "admin-token" | "gui-session" = "admin-token", trustedLoopback = true, issuance: import("../../src/server/gui-session").GuiSessionIssuance | null = null, paired = true, cfg?: OcxConfig) {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const response = await handleManagementAPI(req, url, cfg ?? config(), deps, principal, { isPaired: () => paired, isCurrent: () => true, revokeCurrent: () => true }, { trustedLoopback, guiSessionIssuance: issuance });
  return response;
}

afterEach(() => { if (temp) { try { rmSync(temp, { recursive: true, force: true }); } catch {} temp = ""; } });

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
