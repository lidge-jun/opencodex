import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import type { ManagementAuthState } from "../../src/server/management-auth";
import type { OcxClientConnectionConfig } from "../../src/types";
import type { LinkPathConfigDeps } from "../../src/link/ssh-route";
import { childLinkTraffic } from "../../src/link/traffic";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_KEY = `ocx_data_${"e".repeat(40)}`;
const LINK_ID = "lnk_00000000000000cc";
const TUNNEL_PORT = 23456;
let root = "";
let previousHome: string | undefined;
const servers: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-child-traffic-status-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

const connection: OcxClientConnectionConfig = {
  serverUrl: `http://127.0.0.1:${TUNNEL_PORT}`, managementUrl: `http://127.0.0.1:${TUNNEL_PORT}`, managementTransport: "direct",
  transport: "link", link: { tunnelPort: TUNNEL_PORT, linkId: LINK_ID }, selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "link-key-1", tokenFingerprint: serviceApiTokenFingerprint(LINK_KEY), protocolVersion: 1, connectedAt: "2026-09-26T00:00:00.000Z",
};

function authState(): ManagementAuthState {
  return { available: true, token: `ocx_admin_${"a".repeat(43)}`, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

/** The ssh configuration the status read may consult, recording every file it reads. */
function recordingConfig(body: string): { deps: LinkPathConfigDeps; reads: string[] } {
  const reads: string[] = [];
  return { reads, deps: { home: "/home/fixture", systemConfig: null, glob: () => [], readFile: path => {
    reads.push(path);
    if (path === "/home/fixture/.ssh/config") return body;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } } };
}

function meta(html: string, name: string): string {
  const match = new RegExp(`<meta name="${name}" content="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

test("a connected Child's status read with ?traffic=1 shows its link, the bytes its relay carried and its SSH path", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: connection }));
  const config = recordingConfig("Host home-mac\n  ProxyCommand pen pipe home\n");
  const server = startMachineListener(0, {
    state: connection, managementAuthState: authState(), linkPathConfig: config.deps,
    linkStatus: () => ({ kind: "tunnel", linkId: LINK_ID, state: { kind: "connected", since: Date.parse("2026-09-26T01:00:00.000Z") }, pid: 4242 }),
    readSidecar: () => ({ linkId: LINK_ID, alias: "home-mac", hubHostKeyFingerprint: `SHA256:${"a".repeat(43)}`, peerListenerPort: 45678, tunnelPort: TUNNEL_PORT }),
  });
  servers.push(server);
  const html = await (await fetch(new URL("/opencodex-session", server.url))).text();
  const headers = { "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"), "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin") };
  const flow = childLinkTraffic.begin(LINK_ID);
  flow.toHome(321); flow.fromHome(45); flow.end(true);

  const plain = await (await fetch(new URL("/api/link/status", server.url), { headers })).json() as { links: unknown[] };
  expect(plain.links).toEqual([]);
  expect(config.reads).toEqual([]);
  const counted = await (await fetch(new URL("/api/link/status?traffic=1", server.url), { headers })).json() as Record<string, unknown> & { links: Array<Record<string, unknown>> };
  expect({ ...counted, links: [] }).toEqual(plain);
  expect(counted.links).toEqual([{
    id: LINK_ID, alias: "home-mac", direction: "client-initiated", state: "connected", since: "2026-09-26T01:00:00.000Z", reason: null,
    tunnelPort: TUNNEL_PORT, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null, reportedAt: null,
    traffic: { ...childLinkTraffic.snapshot(LINK_ID) }, path: { via: "proxy-command" },
  }]);
  expect(counted.links[0]!.traffic).toMatchObject({ toHomeBytes: 321, fromHomeBytes: 45, toHomeSource: "relayed" });
  expect(config.reads).toEqual(["/home/fixture/.ssh/config"]);
});

for (const [label, sidecar, reason] of [
  ["unreadable", () => { throw new Error("damaged"); }, "sidecar_invalid"],
  ["another link's", () => ({ linkId: "lnk_00000000000000dd", alias: "elsewhere", hubHostKeyFingerprint: `SHA256:${"a".repeat(43)}`, peerListenerPort: 45678, tunnelPort: TUNNEL_PORT }), "sidecar_mismatch"],
] as const) {
  test(`an ${label} sidecar makes the traffic row failed with an unknown alias and resolves nothing`, async () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: connection }));
    const config = recordingConfig("Host *\n  ProxyCommand x\n");
    const server = startMachineListener(0, {
      state: connection, managementAuthState: authState(), linkPathConfig: config.deps,
      linkStatus: () => ({ kind: "tunnel", linkId: LINK_ID, state: { kind: "connected", since: Date.parse("2026-09-26T01:00:00.000Z") }, pid: 4242 }),
      readSidecar: sidecar as () => null,
    });
    servers.push(server);
    const html = await (await fetch(new URL("/opencodex-session", server.url))).text();
    const headers = { "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"), "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin") };
    const counted = await (await fetch(new URL("/api/link/status?traffic=1", server.url), { headers })).json() as { links: Array<Record<string, unknown>> };
    expect(counted.links[0]).toMatchObject({ id: LINK_ID, alias: "unknown", direction: "client-initiated", state: "failed", reason, path: { via: "unknown" } });
    expect(config.reads).toEqual([]);
  });
}

test("a lost sidecar under a Child-initiated marker makes the traffic row failed, not a Home-initiated idle link", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: connection }));
  mkdirSync(join(root, "link"), { recursive: true });
  writeFileSync(join(root, "link", "child-initiated.json"), JSON.stringify({ linkId: LINK_ID }));
  const config = recordingConfig("Host *\n  ProxyCommand x\n");
  const server = startMachineListener(0, { state: connection, managementAuthState: authState(), linkPathConfig: config.deps, readSidecar: () => null });
  servers.push(server);
  const html = await (await fetch(new URL("/opencodex-session", server.url))).text();
  const headers = { "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"), "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin") };
  const counted = await (await fetch(new URL("/api/link/status?traffic=1", server.url), { headers })).json() as { links: Array<Record<string, unknown>> };
  expect(counted.links[0]).toMatchObject({ alias: "unknown", direction: "client-initiated", state: "failed", reason: "sidecar_missing", path: { via: "unknown" } });
  expect(config.reads).toEqual([]);
});

test("no sidecar and no marker is a Home-initiated link that reads idle since it connected", async () => {
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, runtimeRole: "client", client: connection }));
  const server = startMachineListener(0, { state: connection, managementAuthState: authState(), readSidecar: () => null });
  servers.push(server);
  const html = await (await fetch(new URL("/opencodex-session", server.url))).text();
  const headers = { "X-OpenCodex-API-Key": meta(html, "opencodex-session-token"), "X-OpenCodex-GUI-Origin": meta(html, "opencodex-session-origin") };
  const counted = await (await fetch(new URL("/api/link/status?traffic=1", server.url), { headers })).json() as { links: Array<Record<string, unknown>> };
  expect(counted.links[0]).toMatchObject({ direction: "hub-initiated", state: "idle", since: connection.connectedAt, reason: null, path: { via: "unknown" } });
  // The row names the Home it reached, never the loopback URL the Child connects to.
  expect(counted.links[0]!.alias).toBe("unknown");
  expect(JSON.stringify(counted.links[0])).not.toContain(connection.serverUrl);
});
