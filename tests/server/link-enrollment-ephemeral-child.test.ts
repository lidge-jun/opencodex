import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { remoteInspectRuntimeArgv, remotePlantChildArgv, remotePurgePlantedChildArgv } from "../../src/link/remote-plant";
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
const fakeBinary = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
const fakeSha = createHash("sha256").update(fakeBinary).digest("hex");
const ok = (stdout = "", code = 0, stderr = ""): SshRunResult => ({ code, stdout, stderr });
const http200 = (body: unknown) => ok(`${JSON.stringify(body)}\n200`);
type Step = "inspect" | "plant" | "purgePlant" | "port" | "config" | "curl" | "before" | "connect" | "restart" | "health" | "catalog" | "disconnect" | "disconnectPurge" | "managedPurge";

function buildHarness() {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, "posix"));
  const inspectCmd = quoteRemote(remoteInspectRuntimeArgv("posix"));
  const plantCmd = quoteRemote(remotePlantChildArgv("posix", fakeBinary.byteLength, fakeSha));
  const purgePlantCmd = quoteRemote(remotePurgePlantedChildArgv("posix"));
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
  let plantedBytes: Uint8Array | undefined;
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
      const step: Step = command === inspectCmd ? "inspect"
        : command === plantCmd ? "plant"
        : command === purgePlantCmd ? "purgePlant"
        : command.includes("ocx-managed-purge") ? "managedPurge"
        : command === remoteOcx(["link", "port"]) ? "port"
        : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl"
        : command.includes("'connect' '--link' '--key-stdin'") ? "connect"
        : command === remoteOcx(["restart"]) ? "restart"
        : command === remoteOcx(["disconnect"]) ? "disconnect"
        : command === remoteOcx(["disconnect", "--purge"]) ? "disconnectPurge"
        : command.includes("'ocx-child-http' '10100' 'healthz'") ? (restarted ? "health" : "before")
        : command.includes("'ocx-child-http' '10100' 'v1/catalog'") ? "catalog"
        : (() => { throw new Error(`Unexpected SSH command: ${command}`); })();
      events.push(step);
      if (step === "restart") restarted = true;
      if (step === "plant") plantedBytes = options?.stdin as Uint8Array;
      if (step === "connect") {
        const body = JSON.parse(new TextDecoder().decode(options?.stdin as Uint8Array));
        enrollmentKeyId = body.apiKeyId;
      }
      if (overrides[step]) return overrides[step]!();
      switch (step) {
        case "inspect": return ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:missing\n");
        case "plant": return ok();
        case "purgePlant": return ok();
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
        case "disconnectPurge": return ok();
        case "managedPurge": return ok('{"restored":true,"outcome":"Restored","daemonRunning":false,"purged":true}\n');
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
    resolveChildBinarySource: target => target === "linux-x64"
      ? { ok: true, artifact: { targetTriple: "linux-x64", bytes: fakeBinary, sizeBytes: fakeBinary.byteLength, sha256: fakeSha, source: "cache" } }
      : { ok: false, reason: "artifact_not_found" },
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

  async function request(method: string, path: string, body?: unknown, principal: "admin-token" | "gui-session" = "admin-token") {
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
      principal,
      trustedLoopbackIngress: true,
      guiSessionIssuance: principal === "gui-session" ? "loopback" : null,
      sessionControl: { isCurrent: () => true, isPaired: () => true, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("unused"); },
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const resp = await handleLinkRoutes(ctx, state);
    if (!resp) throw new Error("unhandled");
    return resp;
  }

  return { state, deps, events, overrides, request, get store() { return store; }, get plantedBytes() { return plantedBytes; } };
}

describe("Home Remote Link enrollment, SSH plant, and --purge removal with ephemeral ocx-child", () => {
  test("enrolls a clean detached ocx-child, persists childKind=ephemeral, supports DELETE --purge, and isolates homeCodexSettingsDigest to gui-session", async () => {
    const h = buildHarness();
    const res = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(res.status).toBe(202);
    const body = await res.json() as { linkId: string };
    expect(body.linkId).toMatch(/^lnk_[0-9a-f]{16}$/);
    expect(h.store.links[0]?.childKind).toBe("ephemeral");

    const adminStatus = await (await h.request("GET", "/api/link/status", undefined, "admin-token")).json() as Record<string, unknown>;
    expect(adminStatus).not.toHaveProperty("homeCodexSettingsDigest");
    expect((adminStatus.links as Array<{ childKind?: string }>)[0]?.childKind).toBe("ephemeral");

    const guiStatus = await (await h.request("GET", "/api/link/status", undefined, "gui-session")).json() as Record<string, unknown>;
    expect(typeof guiStatus.homeCodexSettingsDigest).toBe("string");

    const badDel = await h.request("DELETE", `/api/link/${body.linkId}`, { force: true, purge: true });
    expect(badDel.status).toBe(400);

    const del = await h.request("DELETE", `/api/link/${body.linkId}`, { purge: true });
    expect(del.status).toBe(200);
    expect(h.events).toContain("managedPurge");
    expect(h.events).not.toContain("disconnectPurge");
    expect(h.store.links).toHaveLength(0);
  });

  test("DELETE --purge targets the managed planted binary and reports a binary it did not remove as a failure", async () => {
    const h = buildHarness();
    const { linkId } = await (await h.request("POST", "/api/link/apply", { alias: "devbox" })).json() as { linkId: string };
    h.overrides.managedPurge = () => ok('{"restored":true,"outcome":"NotAttached","daemonRunning":false,"purged":false}\n');
    const kept = await h.request("DELETE", "/api/link/" + linkId, { purge: true });
    expect(kept.status).toBe(502);
    expect((await kept.json() as { error: { code: string; hint?: string } }).error).toMatchObject({ code: "remote_disconnect_failed", hint: "purge_incomplete" });
    expect(h.store.links).toHaveLength(1);
    expect(h.events).not.toContain("disconnectPurge");

    h.overrides.managedPurge = () => ok("", 1, "ocx-purge-error:managed_child_missing\n");
    const missing = await h.request("DELETE", "/api/link/" + linkId, { purge: true });
    expect(missing.status).toBe(502);
    expect((await missing.json() as { error: { hint?: string } }).error.hint).toBe("managed_child_missing");
    expect(h.store.links).toHaveLength(1);
  });

  test("DELETE --purge on a link enrolled without childKind inspects the Child instead of silently skipping the purge", async () => {
    const h = buildHarness();
    const { linkId } = await (await h.request("POST", "/api/link/apply", { alias: "devbox" })).json() as { linkId: string };
    delete (h.store.links[0] as { childKind?: string }).childKind;
    const start = h.events.length;
    h.overrides.inspect = () => ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:full\nocx-inspect:version:opencodex 2.98.0\n");
    const full = await h.request("DELETE", "/api/link/" + linkId, { purge: true });
    expect(full.status).toBe(409);
    expect((await full.json() as { error: { code: string } }).error.code).toBe("purge_unsupported");
    expect(h.events.slice(start)).toContain("inspect");
    expect(h.events.slice(start).filter(e => e === "disconnect" || e === "disconnectPurge" || e === "managedPurge")).toEqual([]);
    expect(h.store.links).toHaveLength(1);

    h.overrides.inspect = () => ok("ocx-inspect:uname:Linux:x86_64\nocx-inspect:kind:ephemeral\nocx-inspect:version:ocx-child 2.98.0\n");
    const eph = await h.request("DELETE", "/api/link/" + linkId, { purge: true });
    expect(eph.status).toBe(200);
    expect(h.events.slice(start)).toContain("managedPurge");
    expect(h.store.links).toHaveLength(0);
  });

  test("confirm-host with allowMissing inspects bare host without leaking knownHostLine, refuses apply without plant, and streams plant when authorized", async () => {
    const h = buildHarness();
    h.state.pendingHosts.set("barebox", {
      alias: "barebox",
      fingerprint,
      keyType: "ED25519",
      knownHostLine: "barebox ssh-ed25519 SECRET_LINE",
      probedAt: 1_800_000_000_000,
      remotePlatform: "posix",
    });
    const confirmRes = await h.request("POST", "/api/link/confirm-host", { alias: "barebox", fingerprint, allowMissing: true });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json() as Record<string, unknown>;
    expect(confirmBody).toEqual({
      alias: "barebox",
      fingerprint,
      ocxVersion: null,
      runtimeKind: "missing",
      targetTriple: "linux-x64",
      plantable: true,
      binarySizeBytes: fakeBinary.byteLength,
    });
    expect(confirmBody).not.toHaveProperty("knownHostLine");

    // Apply without plant: true is refused with 409 remote_ocx_missing and leaves confirmedHosts intact
    const missingPlant = await h.request("POST", "/api/link/apply", { alias: "barebox" });
    expect(missingPlant.status).toBe(409);
    expect((await missingPlant.json() as { error: { code: string } }).error.code).toBe("remote_ocx_missing");
    expect(h.events).not.toContain("plant");

    // Apply with plant: true streams exact verified binary bytes over SSH stdin and enrolls
    const applied = await h.request("POST", "/api/link/apply", { alias: "barebox", plant: true });
    expect(applied.status).toBe(202);
    expect(h.events).toContain("plant");
    expect(Array.from(h.plantedBytes ?? [])).toEqual(Array.from(fakeBinary));
    expect(h.store.links[0]?.childKind).toBe("ephemeral");
  });

  test("rolls back freshly planted binary on post-plant failure without residual when purge succeeds, and reports residual if purge fails", async () => {
    const h = buildHarness();
    h.state.confirmedHosts!.set("barebox", {
      alias: "barebox",
      fingerprint,
      keyType: "ED25519",
      knownHostLine: "barebox ssh-ed25519 AAAA",
      probedAt: 1_800_000_000_000,
      remotePlatform: "posix",
      ocxVersion: null,
      runtimeKind: "missing",
      targetTriple: "linux-x64",
      plantable: true,
      binarySizeBytes: fakeBinary.byteLength,
    });
    h.overrides.catalog = () => http200({ malformed: true });
    const res = await h.request("POST", "/api/link/apply", { alias: "barebox", plant: true });
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    expect(h.events).toContain("purgePlant");
    expect(body.residual).toBeUndefined();
    expect(h.store.links).toHaveLength(0);

    // Now simulate purge failure during rollback -> residual: true with --purge recovery
    const h2 = buildHarness();
    h2.state.confirmedHosts!.set("barebox", {
      alias: "barebox",
      fingerprint,
      keyType: "ED25519",
      knownHostLine: "barebox ssh-ed25519 AAAA",
      probedAt: 1_800_000_000_000,
      remotePlatform: "posix",
      ocxVersion: null,
      runtimeKind: "missing",
      targetTriple: "linux-x64",
      plantable: true,
    });
    h2.overrides.before = () => http200({ service: "foreign" });
    h2.overrides.purgePlant = () => { throw new Error("ssh dropped"); };
    const res2 = await h2.request("POST", "/api/link/apply", { alias: "barebox", plant: true });
    expect(res2.status).toBe(409);
    const body2 = await res2.json() as { error: { code: string }; residual?: boolean; recovery?: string };
    expect(body2.error.code).toBe("child_port_busy");
    expect(body2.residual).toBe(true);
    expect(body2.recovery).toContain("detach --purge");
  });

  test("reports hash_tool_unavailable when the Child cannot verify the planted binary's SHA-256", async () => {
    const h = buildHarness();
    h.state.confirmedHosts!.set("barebox", {
      alias: "barebox",
      fingerprint,
      keyType: "ED25519",
      knownHostLine: "barebox ssh-ed25519 AAAA",
      probedAt: 1_800_000_000_000,
      remotePlatform: "posix",
      ocxVersion: null,
      runtimeKind: "missing",
      targetTriple: "linux-x64",
      plantable: true,
      binarySizeBytes: fakeBinary.byteLength,
    });
    h.overrides.plant = () => ok("", 3, "ocx-plant-error:hash_tool_unavailable\nNo sha256sum, shasum, or openssl on this host to verify the binary.\n");
    const res = await h.request("POST", "/api/link/apply", { alias: "barebox", plant: true });
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe("remote_plant_failed");
    expect(body.error.hint).toBe("hash_tool_unavailable");
    expect(h.events).not.toContain("connect");
    expect(h.store.links).toHaveLength(0);
  });

  test("maps child_port_busy and child_external_provider_conflict to 409 without residual", async () => {
    const h = buildHarness();
    h.overrides.before = () => http200({ service: "other" });
    const resBusy = await h.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(resBusy.status).toBe(409);
    expect((await resBusy.json() as { error: { code: string } }).error.code).toBe("child_port_busy");
    expect(h.events).not.toContain("issue");

    const hExt = buildHarness();
    hExt.overrides.connect = () => ok("", 1, "ocx-child-conflict:child_external_provider_conflict: attach refused: an external Codex model_provider (custom) owns config.toml");
    const resExt = await hExt.request("POST", "/api/link/apply", { alias: "devbox" });
    expect(resExt.status).toBe(409);
    const extBody = await resExt.json() as { error: { code: string }; residual?: boolean };
    expect(extBody.error.code).toBe("child_external_provider_conflict");
    expect(extBody.residual).toBeUndefined();
    expect(hExt.store.links).toHaveLength(0);
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

