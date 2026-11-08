import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-ephemeral-enroll-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

const fingerprint = "SHA256:abcdefghijklmnop";
const ok = (stdout = "", code = 0, stderr = ""): SshRunResult => ({ code, stdout, stderr });
const http200 = (body: unknown) => ok(`${JSON.stringify(body)}\n200`);
type Step = "port" | "config" | "curl" | "before" | "connect" | "restart" | "health" | "catalog" | "disconnect";

function buildHarness() {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, "posix"));
  const config: OcxConfig = {
    port: 10100,
    hostname: "127.0.0.1",
    runtimeRole: "standalone",
    defaultProvider: "mock",
    providers: {},
    apiKeys: [],
  };
  const knownHosts = join(root, "known_hosts");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  const clock = 1_800_000_000_000;
  let issued = 0;
  let restarted = false;
  let enrollmentKeyId = "";
  const events: string[] = [];
  const callbacks = new Set<(id: string) => void>();
  const overrides: Partial<Record<Step, () => SshRunResult>> = {};

  const state: LinkRouteState = {
    pendingHosts: new Map(),
    confirmedHosts: new Map(),
    operations: new Set(),
    listener: {
      ensureStarted: async () => { events.push("listener"); },
      status: () => ({ state: "listening", port: 18181, reason: null }),
      close: async () => { events.push("close"); },
      onAuthenticatedCatalog: cb => {
        callbacks.add(cb);
        return () => { callbacks.delete(cb); };
      },
    },
    supervisor: {
      start() {},
      ensureStarted: async () => { events.push("supervisor"); },
      reload: async () => { events.push("reload"); },
      holdLink: id => { events.push(`hold:${id}`); return () => { events.push(`unhold:${id}`); }; },
      stopLink: async id => { events.push(`stop:${id}`); },
      reconnect: async () => true,
      status: () => [],
      stop: async () => {},
    },
  };

  const runner: SshRunner = {
    async run(argv, options) {
      const command = argv.at(-1) ?? "";
      const step: Step = command === remoteOcx(["link", "port"]) ? "port"
        : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl"
        : command.includes("'connect' '--link' '--key-stdin'") ? "connect"
        : command === remoteOcx(["restart"]) ? "restart"
        : command === remoteOcx(["disconnect"]) ? "disconnect"
        : command.includes("'ocx-child-http' '10100' 'healthz'") ? (restarted ? "health" : "before")
        : command.includes("'ocx-child-http' '10100' 'v1/catalog'") ? "catalog"
        : (() => { throw new Error(`Unexpected SSH command: ${command}`); })();
      events.push(step);
      if (step === "restart") restarted = true;
      if (step === "connect") {
        const body = JSON.parse(new TextDecoder().decode(options?.stdin as Uint8Array));
        enrollmentKeyId = body.apiKeyId;
      }
      if (overrides[step]) return overrides[step]!();
      switch (step) {
        case "port": return ok('{"port":24500}');
        case "config": return ok('{"port":10100,"runtimeRole":"standalone","ephemeralChild":true}\n');
        case "curl": return ok();
        case "before": return ok("", 7, "curl: (7) Failed to connect to 127.0.0.1 port 10100");
        case "connect": return ok();
        case "restart": return ok();
        case "health": return http200({ service: "opencodex", version: "2.98.0", role: "client", ephemeralChild: true, pid: 7777, port: 10100, startedAt: "2026-11-07T00:00:00.000Z" });
        case "catalog": {
          for (const cb of callbacks) cb(enrollmentKeyId);
          return http200({ models: [{ slug: "home-m1" }] });
        }
        case "disconnect": return ok();
      }
    },
    spawnTunnel() { throw new Error("unused"); },
  };

  const deps: ManagementContext["deps"] = {
    now: () => clock,
    sshRunner: runner,
    readLinkStore: () => store,
    writeLinkStore: next => { store = next; events.push("store"); },
    linkKnownHostsPath: () => knownHosts,
    liveListenPort: () => 10100,
    issueApiKey: (cfg, name) => {
      const key = { id: `fixture-key-${++issued}`, name, key: "ocx_data_" + "a".repeat(40), createdAt: "2026-11-07T00:00:00Z" };
      cfg.apiKeys = [...(cfg.apiKeys ?? []), key];
      events.push("issue");
      return key;
    },
    revokeApiKey: (cfg, id) => {
      events.push(`revoke:${id}`);
      cfg.apiKeys = (cfg.apiKeys ?? []).filter(k => k.id !== id);
      return true;
    },
  };

  state.confirmedHosts!.set("devbox", {
    alias: "devbox",
    fingerprint,
    keyType: "ED25519",
    knownHostLine: "devbox ssh-ed25519 AAAA",
    probedAt: clock,
    sshLatencyMs: 5,
    remotePlatform: "posix",
    ocxVersion: "2.98.0",
  });

  async function request(method: string, path: string, body?: unknown) {
    const url = new URL(`http://127.0.0.1:10100${path}`);
    const req = new Request(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const ctx: ManagementContext = {
      req,
      url,
      config,
      deps,
      version: "2.98.0",
      principal: "admin-token",
      trustedLoopbackIngress: true,
      guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("unused"); },
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const resp = await handleLinkRoutes(ctx, state);
    if (!resp) throw new Error("unhandled");
    return resp;
  }

  return { events, overrides, request, get store() { return store; } };
}

describe("Home Remote Link enrollment and removal with ephemeral ocx-child", () => {
  test("enrolls a clean detached ocx-child without a pre-running standalone daemon and detaches cleanly on DELETE", async () => {
    const h = buildHarness();
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(202);
    const body = await res.json() as { linkId: string };
    expect(body.linkId).toMatch(/^lnk_[0-9a-f]{16}$/);
    expect(h.store.links).toHaveLength(1);

    const del = await h.request("DELETE", `/api/link/${body.linkId}`);
    expect(del.status).toBe(200);
    expect(h.events).toContain("disconnect");
    expect(h.store.links).toHaveLength(0);
  });

  test("refuses enrollment with 409 before issuing a key when a foreign listener occupies childPort", async () => {
    const h = buildHarness();
    h.overrides.before = () => http200({ service: "other" });
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("child_restart_unsupported");
    expect(h.events).not.toContain("issue");
  });

  test("refuses enrollment with 502 child_preflight_failed when SSH drops (code 255) during before probe", async () => {
    const h = buildHarness();
    h.overrides.before = () => ok("", 255, "Connection reset by peer");
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("child_preflight_failed");
    expect(h.events).not.toContain("issue");
  });

  test("refuses already-attached ocx-child (runtimeRole: client) before probing loopback", async () => {
    const h = buildHarness();
    h.overrides.config = () => ok('{"port":10100,"runtimeRole":"client","ephemeralChild":true}\n');
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(409);
    expect(h.events).not.toContain("before");
    expect(h.events).not.toContain("issue");
  });

  test("emits ephemeralChild-specific detach recovery guidance on post-connect failure without telling operator to run ocx restart", async () => {
    const h = buildHarness();
    h.overrides.restart = () => ok("", 1, "bind error");
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(502);
    const body = await res.json() as { residual: boolean; recovery: string };
    expect(body.residual).toBe(true);
    expect(body.recovery).toBe("Run ocx-child detach (or ocx disconnect) on the Child before retrying.");
    expect(body.recovery).not.toContain("ocx restart");
  });
});
