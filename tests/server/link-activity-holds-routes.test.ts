import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import { createActivityHolds } from "../../src/link/ws-activity-holds";
import * as compensation from "../../src/link/compensation";
import { LINK_WS_LIMITS } from "../../src/server/index/link-websocket-limits";
import { resetSharedChildOpsEngineForTests, sharedChildOpsEngine } from "../../src/link/child-ops-engine";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Lane T5d3a: the operator's view and clear of link WebSocket activity holds through the management API (D8).

const HELD = "lnk_0123456789abcdef";
const FREE = "lnk_fedcba9876543210";

let temp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ocx-link-holds-routes-"));
  for (const name of ["OPENCODEX_HOME", "CODEX_HOME"]) saved[name] = process.env[name];
  process.env.OPENCODEX_HOME = join(temp, "ocx");
  process.env.CODEX_HOME = join(temp, "codex");
  mkdirSync(join(temp, "ocx", "link"), { recursive: true });
  mkdirSync(join(temp, "codex"), { recursive: true });
  writeFileSync(join(temp, "codex", "opencodex-catalog.json"), JSON.stringify({ models: [] }));
});
afterEach(async () => {
  await sharedChildOpsEngine().settled();
  resetSharedChildOpsEngineForTests();
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  removeTreeWithRetry(temp);
});

function link(id: string): LinkRecord {
  return { id, alias: "host-" + id.slice(-4), direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-" + id.slice(-4), createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix" };
}

function harness(options: { runtimeRole?: OcxConfig["runtimeRole"]; withHolds?: boolean; failWrites?: () => boolean; linksReadable?: () => boolean; withTransport?: boolean } = {}) {
  const store: LinkStore = { version: 1, listenerPort: 18181, links: [link(HELD), link(FREE)] };
  writeFileSync(join(temp, "ocx", "link", "links.json"), JSON.stringify(store));
  const holdsDir = join(temp, "holds");
  const closed: string[] = [];
  const holds = createActivityHolds({ dir: holdsDir, linkIds: () => (options.linksReadable?.() ?? true) ? [HELD, FREE] : null, limits: LINK_WS_LIMITS,
    now: () => 1_762_819_000_000,
    writeHooks: { beforeRename(_t, target) { if (options.failWrites?.() && target.endsWith("activity-holds.json")) throw new Error("EIO"); } } });
  holds.start();
  const supervisor: LinkSupervisor = { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, stop: async () => {},
    status: () => [{ linkId: HELD, direction: "hub-initiated", state: { kind: "connected", since: 1_762_000_000_000 }, pid: 1 }] };
  const listener = {
    ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 18181, reason: null }), close: async () => {},
    onAuthenticatedCatalog: () => () => {},
    closeLinkSockets: (linkId: string) => { closed.push(linkId); return 1; },
    linkActivity: (linkId: string, now: number) => ({ inFlight: holds.count(linkId), lastDataEndAt: now - 700_000, observedSince: now - 900_000 }),
    ...(options.withHolds === false ? {} : { linkHolds: (linkId: string) => holds.summary(linkId), clearLinkHolds: (linkId: string) => holds.clear(linkId) }),
    ...(options.withTransport ? { linkTransport: (linkId: string) => ({ open: linkId === HELD ? 1 : 0, upgrades: linkId === HELD ? 2 : 0, refused: linkId === HELD ? { cap: 1 } : {}, closes: {} }) } : {}),
  };
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: options.runtimeRole ?? "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
  const deps: ManagementApiDeps = {
    readLinkStore: () => store, writeLinkStore: () => {}, linkSupervisor: () => supervisor, linkListener: () => listener,
    linkKnownHostsPath: () => join(temp, "known_hosts"), now: () => 1_762_819_200_000, revokeApiKey: () => true,
  };
  const call = async (path: string, method = "GET", body?: unknown, principal: "admin-token" | "gui-session" | null = "admin-token",
    issuance: "pairing" | "tailscale-identity" | null = null) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return (await handleManagementAPI(req, url, config, deps, principal ?? undefined, { isPaired: () => true, isCurrent: () => true, revokeCurrent: () => true },
      { trustedLoopback: true, guiSessionIssuance: issuance }))!;
  };
  const hold = () => { holds.arm(); holds.add(HELD, { threadHash: null, pendingKeys: ["k"], runningMarks: 1, untracked: false }); };
  return { call, holds, hold, closed };
}

const clear = (h: ReturnType<typeof harness>, body: unknown = { linkId: HELD }, principal?: "admin-token" | "gui-session" | null, issuance?: "pairing" | "tailscale-identity" | null) =>
  h.call("/api/link/children/activity/clear", "POST", body, principal === undefined ? "admin-token" : principal, issuance ?? null);

describe("POST /api/link/children/activity/clear", () => {
  test("clears the named link durably, says what it cleared, and logs no content", async () => {
    const h = harness();
    h.hold();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await clear(h);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ linkId: HELD, cleared: { holds: [
        { since: 1_762_819_000_000, reasons: ["pending-results", "running-unknown", "no-thread"], pendingResults: 1, runningTurns: 0, runningUnknown: 1 },
      ], unknown: null } });
      expect(log.mock.calls.map(call => String(call[0]))).toEqual([`[link] activity holds cleared by the operator linkId=${HELD} holds=1 unknown=none`]);
    } finally { log.mockRestore(); }
    expect(h.holds.count(HELD)).toBe(0);
  });

  test("a link with nothing held answers cleared null", async () => {
    const response = await clear(harness(), { linkId: FREE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ linkId: FREE, cleared: null });
  });

  test("refusals: body, unknown link, Child runtime, and a session this route does not admit", async () => {
    const h = harness();
    h.hold();
    for (const body of [null, {}, { linkId: "nope" }, { linkId: HELD, force: true }]) expect((await clear(h, body)).status).toBe(400);
    expect((await clear(h, { linkId: "lnk_1111111111111111" })).status).toBe(404);
    expect((await clear(harness({ runtimeRole: "client" }))).status).toBe(409);
    expect((await clear(h, { linkId: HELD }, "gui-session", "tailscale-identity")).status).toBe(403);
    expect((await clear(h, { linkId: HELD }, null)).status).toBe(403);
    expect(h.holds.count(HELD)).toBe(1);
  });

  test("a failed write clears nothing and answers 503", async () => {
    let fail = false;
    const h = harness({ failWrites: () => fail });
    h.hold();
    fail = true;
    const response = await clear(h);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("activity_holds_write_failed");
    expect(h.holds.count(HELD)).toBe(1);
  });

  test("links that cannot be listed after a crash keep every link held and answer 503", async () => {
    mkdirSync(join(temp, "holds"), { recursive: true });
    writeFileSync(join(temp, "holds", "ws-run-state.json"), '{"version":1,"state":"running"}');
    const h = harness({ linksReadable: () => false });
    const response = await clear(h);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("link_unavailable");
    expect(h.holds.count(HELD)).toBe(1);
  });
});

describe("status with ?children=1", () => {
  const rows = async (h: ReturnType<typeof harness>, query = "?children=1") =>
    ((await (await h.call("/api/link/status" + query)).json()) as { links: Array<{ id: string; child?: Record<string, unknown> }> }).links;

  test("a held row carries its holds and reasons; a free row carries no holds key", async () => {
    const h = harness();
    h.hold();
    const [held, free] = await rows(h);
    expect(held!.child!.holds).toEqual({ holds: [{ since: 1_762_819_000_000, reasons: ["pending-results", "running-unknown", "no-thread"], pendingResults: 1, runningTurns: 0, runningUnknown: 1 }], unknown: null });
    expect((held!.child!.activity as { inFlight: number }).inFlight).toBe(1);
    expect(free!.child).not.toHaveProperty("holds");
  });

  test("without holds the children document is byte-identical to a Home that has no holds at all", async () => {
    const withStore = await (await harness().call("/api/link/status?children=1")).text();
    const without = await (await harness({ withHolds: false }).call("/api/link/status?children=1")).text();
    expect(withStore).toBe(without);
    const plain = await (await harness().call("/api/link/status")).text();
    expect(plain).toBe(await (await harness({ withHolds: false }).call("/api/link/status")).text());
  });
});

describe("status with ?transport=1 (T5e2, design 9.3)", () => {
  const rows = async (h: ReturnType<typeof harness>, query: string) =>
    ((await (await h.call("/api/link/status" + query)).json()) as { links: Array<{ id: string; ws?: unknown }> }).links;

  test("every row carries ws: the live counters and the hold count", async () => {
    const h = harness({ withTransport: true });
    h.hold();
    const [held, free] = await rows(h, "?transport=1");
    expect(held!.ws).toEqual({ open: 1, upgrades: 2, refused: { cap: 1 }, closes: {}, holds: 1 });
    expect(free!.ws).toEqual({ open: 0, upgrades: 0, refused: {}, closes: {}, holds: 0 });
  });

  test("without the query, the default and children documents are byte-identical with or without the counters", async () => {
    for (const query of ["", "?children=1", "?compatibility=1&diagnostics=1&children=1"]) {
      const withCounters = await (await harness({ withTransport: true }).call("/api/link/status" + query)).text();
      const without = await (await harness().call("/api/link/status" + query)).text();
      expect(withCounters).toBe(without);
      expect(withCounters).not.toContain('"ws"');
    }
  });
});
describe("a listener without the clear hook (T5e2-R1-02)", () => {
  test("answers 503 and never reports a successful empty clear", async () => {
    const response = await clear(harness({ withHolds: false }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("activity_holds_unavailable");
  });
});

describe("T5g: revoke fences the link's sockets before fallible cleanup (final review area a, P3)", () => {
  test("a failed compensation cleanup after the commit still closes the link's sockets in the same task", async () => {
    const h = harness();
    const cleanup = spyOn(compensation, "clearCompensationFailed").mockImplementation(() => { throw new Error("EIO"); });
    try {
      const response = await h.call("/api/link/" + HELD, "DELETE", { force: true });
      expect(response.status).toBe(503);
      expect(cleanup).toHaveBeenCalled();
      expect(h.closed).toEqual([HELD]);
    } finally { cleanup.mockRestore(); }
  });
});
