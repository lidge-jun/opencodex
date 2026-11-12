import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunResult, SshRunner } from "../../src/link/ssh-runner";
import { childLinkTraffic, createLinkTrafficBook } from "../../src/link/traffic";
import { classifySshResolvedConfig } from "../../src/link/ssh-route";
import { attachLinkTrafficForState } from "../../src/server/management/link-traffic-status";
import type { LinkRouteState } from "../../src/server/management/link-route-state";
import type { LinkStatusDto } from "../../src/link/status-projection";
import { validateStatus } from "../../src/cli/link";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const HUB = "lnk_0123456789abcdef";
const CLIENT = "lnk_fedcba9876543210";
let temp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ocx-link-traffic-status-"));
  saved.OPENCODEX_HOME = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = join(temp, "ocx");
  mkdirSync(join(temp, "ocx", "link"), { recursive: true });
});
afterEach(() => {
  if (saved.OPENCODEX_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved.OPENCODEX_HOME;
  removeTreeWithRetry(temp);
});

function link(id: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id, alias: "host-" + id.slice(-4), direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-" + id.slice(-4), createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}

function resolvingRunner(answer: SshRunResult, calls: string[][]): SshRunner {
  return {
    async run(argv) { calls.push([...argv]); return answer; },
    spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
  };
}

function harness(answer: SshRunResult, book = createLinkTrafficBook("content-length")) {
  const current: LinkStore = { version: 1, listenerPort: 18181, links: [link(HUB), link(CLIENT, { direction: "client-initiated", hostKeyFingerprint: null })] };
  writeFileSync(join(temp, "ocx", "link", "links.json"), JSON.stringify(current));
  const calls: string[][] = [];
  const supervisor: LinkSupervisor = { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, stop: async () => {},
    status: () => [{ linkId: HUB, direction: "hub-initiated", state: { kind: "connected", since: 1_762_000_000_000 }, pid: 1 }] };
  const listener = { ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 18181, reason: null }), close: async () => {},
    onAuthenticatedCatalog: () => () => {}, linkTraffic: (id: string) => book.snapshot(id) };
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
  const deps: ManagementApiDeps = { readLinkStore: () => current, writeLinkStore: () => {}, linkSupervisor: () => supervisor,
    linkListener: () => listener, linkKnownHostsPath: () => join(temp, "known_hosts"), sshRunner: resolvingRunner(answer, calls) };
  const call = async (path: string) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const response = await handleManagementAPI(new Request(url, { headers: { host: "127.0.0.1" } }), url, config, deps, "admin-token",
      { isPaired: () => true, isCurrent: () => true, revokeCurrent: () => true }, { trustedLoopback: true, guiSessionIssuance: null });
    expect(response?.status).toBe(200);
    return await response!.json() as LinkStatusDto;
  };
  return { call, calls, book };
}

const PEN = { code: 0, stdout: "hostname 192.0.2.10\nproxycommand pen pipe host\nproxyusefdpass no\n", stderr: "" };

describe("GET /api/link/status?traffic=1 (#3023)", () => {
  test("without the query the document is unchanged; with it every existing field stays and two blocks are added", async () => {
    const h = harness(PEN);
    const plain = await h.call("/api/link/status");
    for (const row of plain.links) expect(Object.keys(row)).not.toContain("traffic");
    const counted = await h.call("/api/link/status?traffic=1");
    const stripped = { ...counted, links: counted.links.map(({ traffic: _traffic, path: _path, ...rest }) => rest) };
    expect(stripped).toEqual(plain);
    const [hub, client] = counted.links;
    expect(hub!.traffic).toEqual({ since: expect.any(String), requests: 0, incomplete: 0, toHomeBytes: 0, fromHomeBytes: 0,
      toHomeSource: "content-length", toHomeUncounted: 0 });
    expect(hub!.path).toEqual({ via: "proxy-command" });
    // The Home cannot see how a Child-initiated link's alias goes; it never resolves it.
    expect(client!.path).toEqual({ via: "unknown" });
    expect(h.calls).toEqual([["ssh", "-G", "--", "host-cdef"]]);
    // `ocx link status` validates both shapes key by key.
    expect(validateStatus(plain).links[0]).not.toHaveProperty("traffic");
    expect(validateStatus(counted).links[0]).toMatchObject({ traffic: { requests: 0 }, path: { via: "proxy-command" } });
  });

  test("rows carry what the listener counted, and a second read reuses the resolved path", async () => {
    const h = harness(PEN);
    const flow = h.book.begin(HUB);
    flow.toHome(1234); flow.fromHome(99); flow.end(true);
    await h.call("/api/link/status?traffic=1");
    const again = await h.call("/api/link/status?traffic=1");
    expect(again.links[0]!.traffic).toMatchObject({ requests: 1, toHomeBytes: 1234, fromHomeBytes: 99 });
    expect(h.calls).toHaveLength(1);
  });

  test("an alias that fails to resolve reads unknown", async () => {
    const h = harness({ code: 255, stdout: "", stderr: "bad configuration" });
    expect((await h.call("/api/link/status?traffic=1")).links[0]!.path).toEqual({ via: "unknown" });
  });

  test("ssh -G output classification", () => {
    expect(classifySshResolvedConfig("hostname h\nproxycommand nc %h %p\n")).toBe("proxy-command");
    expect(classifySshResolvedConfig("hostname h\nproxyjump bastion\n")).toBe("proxy-jump");
    expect(classifySshResolvedConfig("hostname h\nproxycommand none\nproxyusefdpass no\n")).toBe("direct");
    expect(classifySshResolvedConfig("hostname h\n")).toBe("direct");
  });

  test("a Child row reads this process's relay book and resolves only the link it initiated", async () => {
    const calls: string[][] = [];
    const runner = resolvingRunner({ code: 0, stdout: "proxyjump bastion\n", stderr: "" }, calls);
    const flow = childLinkTraffic.begin(CLIENT);
    flow.toHome(77); flow.end(true);
    const dto: LinkStatusDto = { role: "child", listener: { state: "off", port: null }, child: null, links: [
      { id: CLIENT, alias: "home-alias", direction: "client-initiated", state: "connected", since: "2026-11-12T00:00:00.000Z", reason: null, tunnelPort: 41000,
        lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null, reportedAt: null },
    ] };
    const state = { listener: {} } as unknown as LinkRouteState;
    await attachLinkTrafficForState(dto, state, () => runner);
    expect(dto.links[0]!.traffic).toMatchObject({ toHomeSource: "relayed", toHomeBytes: childLinkTraffic.snapshot(CLIENT).toHomeBytes });
    expect(dto.links[0]!.traffic!.toHomeBytes).toBeGreaterThanOrEqual(77);
    expect(dto.links[0]!.path).toEqual({ via: "proxy-jump" });
    expect(calls).toEqual([["ssh", "-G", "--", "home-alias"]]);
  });

  test("the CLI refuses a malformed traffic or path block", () => {
    const base = { role: "home", listener: { state: "listening", port: 18181 }, child: null, links: [{ id: HUB, alias: "a", direction: "hub-initiated",
      state: "connected", since: "2026-11-12T00:00:00.000Z", reason: null, tunnelPort: 41000 }] };
    const traffic = { since: "2026-11-12T00:00:00.000Z", requests: 1, incomplete: 0, toHomeBytes: 5, fromHomeBytes: 6, toHomeSource: "relayed", toHomeUncounted: 0 };
    const withRow = (row: Record<string, unknown>) => ({ ...base, links: [{ ...base.links[0], ...row }] });
    expect(() => validateStatus(withRow({ traffic, path: { via: "direct" } }))).not.toThrow();
    expect(() => validateStatus(withRow({ traffic: { ...traffic, toHomeBytes: -1 } }))).toThrow("link 0 traffic");
    expect(() => validateStatus(withRow({ traffic: { ...traffic, extra: 1 } }))).toThrow("link 0 traffic");
    expect(() => validateStatus(withRow({ traffic: { ...traffic, toHomeSource: "guess" } }))).toThrow("link 0 traffic");
    expect(() => validateStatus(withRow({ path: { via: "relay" } }))).toThrow("link 0 path");
  });
});
