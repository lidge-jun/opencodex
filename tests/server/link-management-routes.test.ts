import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  createManagementSessionControl,
  issueGuiSession,
  managementPrincipal,
  managementSessionIssuance,
  type ManagementAuthState,
} from "../../src/server/management-auth";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunner, SshChild, SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";
import { trustedLoopbackForIngress, type ServerIngress } from "../../src/server/index/serve-options";

let temp = "";

/** The remote command a call site must send: ocx wrapped in the PATH prelude, quoted once. */
function remoteOcx(args: readonly string[]): string {
  return quoteRemote(remoteOcxArgv(args));
}

/** A bare `ocx` exec (a call site that skipped `remoteOcxArgv`) behaves like a remote without it. */
const BARE_OCX: SshRunResult = { code: 127, stdout: "", stderr: "bare ocx call: not wrapped by remoteOcxArgv" };

function isBareOcx(argv: readonly string[]): boolean {
  return /^'ocx'( |$)/.test(argv.at(-1) ?? "");
}

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
      if (isBareOcx(argv)) return BARE_OCX;
      const remote = argv.at(-1) ?? "";
      if (remote === remoteOcx(["--version"])) return { code: 0, stdout: "opencodex 2.66.0\n", stderr: "" };
      if (remote === remoteOcx(["link", "port"])) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
      if (remote.startsWith(`${remoteOcx(["connect", "--link", "--key-stdin", "--tunnel-port", "2200", "--link-id"])} `)) {
        const raw = new TextDecoder().decode(options?.stdin as Uint8Array);
        const id = JSON.parse(raw).apiKeyId as string;
        for (const callback of h.callbacks) callback(id);
        return { code: connectCode, stdout: "", stderr: "" };
      }
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

/** No isPaired stub: the principal, issuance and session control come from the real auth code. */
async function sessionCall(url: string, headers: Record<string, string>, state: ManagementAuthState, cfg: OcxConfig, deps: ManagementApiDeps, trustedLoopback: boolean, method = "GET", body?: unknown) {
  const req = new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleManagementAPI(req, new URL(url), cfg, deps, managementPrincipal(req, state, cfg) ?? undefined, createManagementSessionControl(state), {
    trustedLoopback,
    guiSessionIssuance: managementSessionIssuance(req, state),
  });
}

function authState(): ManagementAuthState {
  return { available: true, token: `ocx_admin_${"a".repeat(43)}`, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

function versionRunner(remote: { probeCode: number; probeStderr: string; code: number; stdout: string; stderr: string }): SshRunner {
  return {
    async run(argv) {
      const text = argv.join(" ");
      if (text.includes("ssh-keygen")) return { code: 0, stdout: "256 SHA256:abcdefghijklmnop host (ED25519)", stderr: "" };
      if (isBareOcx(argv)) return BARE_OCX;
      if (argv.at(-1) === remoteOcx(["--version"])) return { code: remote.code, stdout: remote.stdout, stderr: remote.stderr };
      const knownHostOption = argv.find(value => value.startsWith("UserKnownHostsFile="));
      if (knownHostOption) writeFileSync(knownHostOption.slice("UserKnownHostsFile=".length), "client ssh-ed25519 AAAA\n");
      return argv.at(-1) === "true" ? { code: remote.probeCode, stdout: "", stderr: remote.probeStderr } : { code: 0, stdout: "", stderr: "" };
    },
    spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
  };
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
    // A loopback hostname never makes the hub-link, hub-management or intercept ingress trusted.
    for (const ingress of ["hub-link", "hub-management", "claude-intercept"] as const) {
      expect(trustedLoopbackForIngress(ingress, "127.0.0.1")).toBe(false);
    }
  });

  test("admits the current loopback dashboard session of a standalone runtime on trusted loopback ingress", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-loopback-session-"));
    const h = harness();
    const state = authState();
    const cfg = { ...h.config, runtimeRole: "standalone" } as OcxConfig;
    const session = issueGuiSession(new Request("http://127.0.0.1:10100/", { headers: { host: "127.0.0.1:10100" } }), cfg, state);
    expect(session?.issuance).toBe("loopback");
    const headers = { host: "127.0.0.1:10100", authorization: `Bearer ${session!.token}`, "x-opencodex-gui-origin": session!.browserOrigin };
    const deps: ManagementApiDeps = { ...h.deps, sshRunner: applyRunner(h), loadLinkCandidates: () => [{ alias: "home", source: "ssh_config" }] } as ManagementApiDeps;
    const base = "http://127.0.0.1:10100";

    const status = await sessionCall(`${base}/api/link/status`, headers, state, cfg, deps, true);
    expect(status?.status).toBe(200);
    expect(await status!.json()).toMatchObject({ role: "standalone", joinAvailable: false });
    const listed = await sessionCall(`${base}/api/link/candidates`, headers, state, cfg, deps, true);
    expect(listed?.status).toBe(200);
    expect(await listed!.json()).toEqual({ candidates: [{ alias: "home", source: "ssh_config" }] });
    const mutation = { ...headers, origin: session!.browserOrigin, "x-opencodex-csrf-token": session!.csrfToken };
    expect((await sessionCall(`${base}/api/link/probe`, mutation, state, cfg, deps, true, "POST", { alias: "home" }))?.status).toBe(200);
    expect((await sessionCall(`${base}/api/link/probe`, headers, state, cfg, deps, true, "POST", { alias: "home" }))?.status).toBe(403);
    expect((await sessionCall(`${base}/api/link/confirm-host`, mutation, state, cfg, deps, true, "POST", { alias: "home", fingerprint: "SHA256:abcdefghijklmnop" }))?.status).toBe(200);

    // Joining restarts this runtime and moves Codex routing to the Home, so it stays paired-only.
    const joined = await sessionCall(`${base}/api/link/join`, mutation, state, cfg, deps, true, "POST", { alias: "home" });
    expect(joined?.status).toBe(403);
    expect(await joined!.json()).toMatchObject({ error: { code: "forbidden" } });

    // The Home side runs end to end for this session: apply issues and connects, removal disconnects.
    const applied = await sessionCall(`${base}/api/link/apply`, mutation, state, cfg, deps, true, "POST", { alias: "home" });
    expect(applied?.status).toBe(202);
    const { linkId } = await applied!.json() as { linkId: string };
    expect(h.store.links.map(link => link.id)).toEqual([linkId]);
    for (const runtimeRole of ["hub", "client"] as const) {
      const refusedApply = await sessionCall(`${base}/api/link/apply`, mutation, state, { ...cfg, runtimeRole } as OcxConfig, deps, true, "POST", { alias: "home" });
      expect(refusedApply?.status).toBe(403);
      expect(await refusedApply!.json()).toMatchObject({ error: { code: "forbidden" } });
    }
    const removed = await sessionCall(`${base}/api/link/${linkId}`, mutation, state, cfg, deps, true, "DELETE", {});
    expect(removed?.status).toBe(200);
    expect(await removed!.json()).toEqual({ linkId });
    expect(h.store.links).toEqual([]);
    expect(cfg.apiKeys).toEqual([]);

    const untrusted = await sessionCall(`${base}/api/link/candidates`, headers, state, cfg, deps, false);
    expect(untrusted?.status).toBe(403);
    expect(await untrusted!.json()).toMatchObject({ error: { code: "forbidden" } });
    for (const runtimeRole of ["hub", "client"] as const) {
      const other = await sessionCall(`${base}/api/link/candidates`, headers, state, { ...cfg, runtimeRole } as OcxConfig, deps, true);
      expect(other?.status).toBe(403);
      expect(await other!.json()).toMatchObject({ error: { code: "forbidden" } });
    }

    const tailscaleConfig = {
      ...cfg, hostname: "0.0.0.0", runtimeRole: "hub", hub: { managementPublicOrigin: "https://hub.example.test" },
      remoteGui: { allowedTailscaleUsers: ["alice@example.test"] }, corsAllowOrigins: ["https://dashboard.example.test"],
    } as OcxConfig;
    const tailscale = issueGuiSession(new Request("https://hub.example.test/", {
      headers: { host: "hub.example.test", origin: "https://dashboard.example.test", "Tailscale-User-Login": "alice@example.test" },
    }), tailscaleConfig, state, { trustedTailscaleIngress: true });
    expect(tailscale?.issuance).toBe("tailscale-identity");
    const refused = await sessionCall("https://hub.example.test/api/link/candidates", {
      host: "hub.example.test", authorization: `Bearer ${tailscale!.token}`, "x-opencodex-gui-origin": tailscale!.browserOrigin,
    }, state, tailscaleConfig, deps, true);
    expect(refused?.status).toBe(403);
    expect(await refused!.json()).toMatchObject({ error: { code: "tailscale_session_refused" } });
  });

  test("status tells a dashboard session whether it may join and keeps the admin-token DTO exact", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-join-available-"));
    const h = harness();
    const standalone = { ...h.config, runtimeRole: "standalone" } as OcxConfig;
    const paired = await call("/api/link/status", "GET", undefined, h.deps, "gui-session", true, "pairing", true, standalone);
    expect(paired?.status).toBe(200);
    expect(await paired!.json()).toMatchObject({ role: "standalone", joinAvailable: true });
    const hub = await call("/api/link/status", "GET", undefined, h.deps, "gui-session", true, "pairing", true, { ...standalone, runtimeRole: "hub" } as OcxConfig);
    expect(await hub!.json()).toMatchObject({ joinAvailable: false });
    // `ocx link status` validates the admin-token answer key by key, so it never gains the field.
    const admin = await call("/api/link/status", "GET", undefined, h.deps, "admin-token", true, null, true, standalone);
    expect(Object.keys(await admin!.json()).sort()).toEqual(["child", "links", "listener", "role"]);
  });

  test("confirm-host keeps the parsed remote version to a bounded semver shape", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-version-shape-"));
    const h = harness();
    const remote = { probeCode: 0, probeStderr: "", code: 0, stdout: "", stderr: "" };
    const deps = { ...h.deps, sshRunner: versionRunner(remote) };
    const post = (path: string, body: unknown) => call(path, "POST", body, deps, "gui-session", true, "pairing", true, h.config);
    expect((await post("/api/link/probe", { alias: "home" }))?.status).toBe(200);
    const confirm = () => post("/api/link/confirm-host", { alias: "home", fingerprint: "SHA256:abcdefghijklmnop" });
    const unrecognized = { error: { code: "remote_ocx_unrecognized", message: "The remote ocx did not report an OpenCodex version." } };

    for (const stdout of [
      `opencodex 2.66.0-${"a".repeat(65)}\n`,
      `opencodex 2.66.0+${"b".repeat(200)}\n`,
      `opencodex 2.66.0${String.fromCharCode(0x202e)}evil\n`,
      `opencodex 2.66.0-rc.1${String.fromCharCode(0x7)}\n`,
      `opencodex 2.66.0/../../x\n`,
      `opencodex 1${"0".repeat(12)}.0.0\n`,
    ]) {
      Object.assign(remote, { stdout });
      const refused = await confirm();
      expect(refused?.status).toBe(502);
      expect(await refused!.json()).toEqual(unrecognized);
    }

    // The outdated hint goes through the stderr hint bounding, so even the longest accepted
    // version cannot grow it past 160 characters.
    Object.assign(remote, { stdout: `opencodex 000000001.000000002.000000003-${"a".repeat(64)}+${"b".repeat(64)}\n` });
    const outdated = await confirm();
    expect(outdated?.status).toBe(409);
    const hint = ((await outdated!.json()) as { error: { hint: string } }).error.hint;
    expect(hint.startsWith("opencodex 000000001.000000002.000000003-aaaa")).toBe(true);
    expect(hint).toHaveLength(160);
    expect(hint.endsWith("…")).toBe(true);

    Object.assign(remote, { stdout: "opencodex 2.70.0-rc.1+build.7 (darwin arm64)\n" });
    const confirmed = await confirm();
    expect(confirmed?.status).toBe(200);
    expect(await confirmed!.json()).toEqual({ alias: "home", fingerprint: "SHA256:abcdefghijklmnop", ocxVersion: "2.70.0-rc.1+build.7" });
  });

  test("confirm-host enforces the remote ocx floor, maps failures, and keeps the probe for a retry", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-version-floor-"));
    const h = harness();
    const remote = { probeCode: 255, probeStderr: "\u001b[1mhome: Permission denied (publickey).\u001b[0m\n", code: 0, stdout: "opencodex 2.32.1\n", stderr: "" };
    const deps = { ...h.deps, sshRunner: versionRunner(remote) };
    const knownHosts = join(temp, "known_hosts");
    const post = (path: string, body: unknown) => call(path, "POST", body, deps, "gui-session", true, "pairing", true, h.config);
    const confirm = () => post("/api/link/confirm-host", { alias: "home", fingerprint: "SHA256:abcdefghijklmnop" });

    const probeFailed = await post("/api/link/probe", { alias: "home" });
    expect(probeFailed?.status).toBe(502);
    expect(await probeFailed!.json()).toEqual({ error: { code: "probe_failed", message: "SSH host probing failed.", hint: "home: Permission denied (publickey)." } });
    remote.probeCode = 0;
    expect((await post("/api/link/probe", { alias: "home" }))?.status).toBe(200);

    const outdated = await confirm();
    expect(outdated?.status).toBe(409);
    expect(await outdated!.json()).toEqual({ error: { code: "remote_ocx_outdated", message: "The remote OpenCodex is older than 2.66.0.", hint: "opencodex 2.32.1" } });
    expect(existsSync(knownHosts)).toBe(false);

    for (const [code, stdout, stderr, status, body] of [
      [0, "opencodex (ocx) — Universal provider proxy for Codex\nUsage: ocx <command>\n", "", 502, { code: "remote_ocx_unrecognized", message: "The remote ocx did not report an OpenCodex version." }],
      [127, "", "sh: 1: exec: ocx: not found\n", 502, { code: "remote_ocx_missing", message: "ocx was not found on the remote host.", hint: "sh: 1: exec: ocx: not found" }],
      [255, "", "ssh: connect to host home port 22: Connection refused\r\n", 502, { code: "version_probe_failed", message: "The remote ocx version could not be confirmed.", hint: "ssh: connect to host home port 22: Connection refused" }],
    ] as const) {
      Object.assign(remote, { code, stdout, stderr });
      const refused = await confirm();
      expect(refused?.status).toBe(status);
      expect(await refused!.json()).toEqual({ error: body });
      expect(existsSync(knownHosts)).toBe(false);
    }

    Object.assign(remote, { code: 0, stdout: "opencodex 2.66.0-preview.20260925\n", stderr: "" });
    const confirmed = await confirm();
    expect(confirmed?.status).toBe(200);
    expect(await confirmed!.json()).toEqual({ alias: "home", fingerprint: "SHA256:abcdefghijklmnop", ocxVersion: "2.66.0-preview.20260925" });
    expect(existsSync(knownHosts)).toBe(true);
  });

  test("a probe hint of astral stderr is cut by code point, never before a lone surrogate", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-astral-hint-"));
    const h = harness();
    const astral = String.fromCodePoint(0x1f511);
    const deps = { ...h.deps, sshRunner: versionRunner({ probeCode: 255, probeStderr: `${astral.repeat(200)}\n`, code: 0, stdout: "", stderr: "" }) };
    const probed = await call("/api/link/probe", "POST", { alias: "home" }, deps, "gui-session", true, "pairing", true, h.config);
    expect(probed?.status).toBe(502);
    const points = Array.from(((await probed!.json()) as { error: { hint: string } }).error.hint);
    expect(points).toHaveLength(160);
    expect(points.slice(0, -1).every(point => point === astral)).toBe(true);
    expect(points.at(-1)).toBe(String.fromCodePoint(0x2026));
  });

  test("apply maps a missing remote ocx to remote_ocx_missing before issuing a key", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-apply-ocx-missing-"));
    const h = harness();
    const base = applyRunner(h);
    const runner: SshRunner = {
      ...base,
      async run(argv, options) {
        if (argv.at(-1) === remoteOcx(["link", "port"])) return { code: 127, stdout: "", stderr: "zsh:1: command not found: ocx\n" };
        return base.run(argv, options);
      },
    };
    const deps = { ...h.deps, sshRunner: runner };
    expect((await call("/api/link/probe", "POST", { alias: "no-ocx" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    expect((await call("/api/link/confirm-host", "POST", { alias: "no-ocx", fingerprint: "SHA256:abcdefghijklmnop" }, deps, "gui-session", true, "pairing", true, h.config))?.status).toBe(200);
    const response = await call("/api/link/apply", "POST", { alias: "no-ocx" }, deps, "gui-session", true, "pairing", true, h.config);
    expect(response?.status).toBe(502);
    expect(await response!.json()).toEqual({ error: { code: "remote_ocx_missing", message: "ocx was not found on the remote host.", hint: "zsh:1: command not found: ocx" } });
    expect(h.events).not.toContain("issue");
    expect(h.config.apiKeys).toEqual([]);
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
      async run(argv) {
        if (argv.at(-1) !== remoteOcx(["disconnect"])) return BARE_OCX;
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

  test("issue starts the supervisor once a recovered listener binds", async () => {
    temp = mkdtempSync(join(tmpdir(), "ocx-link-issue-recover-"));
    const h = harness();
    h.setListenerState("failed");
    const deps = {
      ...h.deps,
      linkListener: () => ({
        ...h.listener,
        ensureStarted: async () => { h.events.push("listener"); h.setListenerState("listening"); },
      }),
    };
    const response = await call("/api/link/issue", "POST", { alias: "home", tunnelPort: 2200 }, deps, "admin-token", true, null, true, h.config);
    expect(response?.status).toBe(200);
    expect(h.events.indexOf("listener")).toBeLessThan(h.events.indexOf("supervisor"));
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
        if (isBareOcx(argv)) return BARE_OCX;
        if (argv.at(-1) === remoteOcx(["--version"])) return { code: 0, stdout: "opencodex 2.66.0\n", stderr: "" };
        if (argv.at(-1) === remoteOcx(["link", "port"])) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
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
        if (isBareOcx(argv)) return BARE_OCX;
        const remote = argv.at(-1) ?? "";
        if (remote === remoteOcx(["--version"])) return { code: 0, stdout: "opencodex 2.66.0\n", stderr: "" };
        if (remote.startsWith(`${remoteOcx(["connect", "--link", "--key-stdin", "--tunnel-port", "2200", "--link-id"])} `)) {
          h.events.push("connect");
          const raw = typeof options?.stdin === "string" ? options.stdin : new TextDecoder().decode(options?.stdin);
          const id = JSON.parse(raw ?? "{}").apiKeyId as string;
          for (const callback of h.callbacks) callback(id);
        }
        if (remote === remoteOcx(["link", "port"])) return { code: 0, stdout: JSON.stringify({ port: 2200 }), stderr: "" };
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
