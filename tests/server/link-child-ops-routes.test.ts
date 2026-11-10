import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import { requireManagementAuth } from "../../src/server/management-auth";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import type { LinkSupervisor } from "../../src/link/supervisor";
import type { SshRunResult, SshRunner } from "../../src/link/ssh-runner";
import { readChildObservations } from "../../src/link/child-observations";
import { catalogEtag } from "../../src/server/catalog-download";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const HUB = "lnk_0123456789abcdef";
const CLIENT = "lnk_fedcba9876543210";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345_-";
const PLAN = { schema: "ocx.update.plan/1", currentVersion: "2.97.0", targetVersion: "2.100.0", installer: "bun", runtimeOwner: "service",
  servingPath: "/opt/ocx", cliPath: "/opt/ocx", canApply: false, reason: "up-to-date", restartRequired: false, planToken: TOKEN, updateInFlight: false,
  mutationBoundMs: 900_000 };
const PLAN_ANSWER: SshRunResult = { code: 0, stdout: "ocx-fanout:stdout-begin\n" + JSON.stringify(PLAN) + "\n",
  stderr: "ocx-fanout:selected:2.97.0\nocx-fanout:entry:binary\nocx-fanout:child-now:1762819200000\n" };

let temp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ocx-child-ops-routes-"));
  for (const name of ["OPENCODEX_HOME", "CODEX_HOME"]) saved[name] = process.env[name];
  process.env.OPENCODEX_HOME = join(temp, "ocx");
  process.env.CODEX_HOME = join(temp, "codex");
  mkdirSync(join(temp, "ocx", "link"), { recursive: true });
  mkdirSync(join(temp, "codex"), { recursive: true });
  writeFileSync(join(temp, "codex", "opencodex-catalog.json"), JSON.stringify({ models: [] }));
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  removeTreeWithRetry(temp);
});

function link(id: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return { id, alias: "host-" + id.slice(-4), direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345",
    tunnelPort: 41000, apiKeyId: "key-" + id.slice(-4), createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix", ...overrides };
}

function supervisor(): LinkSupervisor {
  return { start() {}, ensureStarted: async () => {}, reload: async () => {}, stopLink: async () => {}, status: () => [], stop: async () => {} };
}

function harness(options: { links?: LinkRecord[]; runtimeRole?: OcxConfig["runtimeRole"]; gate?: Promise<void>; full?: boolean; onFlush?: () => void } = {}) {
  let current: LinkStore = { version: 1, listenerPort: 18181, links: options.links ?? [link(HUB), link(CLIENT, { direction: "client-initiated", hostKeyFingerprint: null })] };
  // Persisted too: the observation cache prunes entries whose link is absent from links.json.
  writeFileSync(join(temp, "ocx", "link", "links.json"), JSON.stringify(current));
  const events: string[] = [];
  const sshCalls: string[] = [];
  const runner: SshRunner = {
    async run(argv) {
      sshCalls.push(argv.at(-1) ?? "");
      if (options.gate) await options.gate;
      return PLAN_ANSWER;
    },
    spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill() {} }),
  };
  const listener = {
    ensureStarted: async () => {}, status: () => ({ state: "listening" as const, port: 18181, reason: null }), close: async () => {},
    onAuthenticatedCatalog: () => () => {},
    ...(options.full ? {
      peerObservation: () => ({ observed: { reported: true, version: "2.96.0", features: null, relayAuth: "2", observedAt: "2026-11-11T00:00:00.000Z" }, refused: null }),
      linkActivity: (_id: string, now: number) => ({ inFlight: 0, lastDataEndAt: now - 700_000, observedSince: now - 900_000 }),
      catalogPull: () => ({ at: 1_762_000_000_000, etag: catalogEtag(JSON.stringify({ models: [] })) }),
      flushCatalogPulls: () => { options.onFlush?.(); },
    } : {}),
  };
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: options.runtimeRole ?? "hub", defaultProvider: "mock", providers: {}, apiKeys: [] } as OcxConfig;
  const deps: ManagementApiDeps = {
    readLinkStore: () => current,
    writeLinkStore: next => { current = next; events.push("store"); },
    linkSupervisor: () => supervisor(),
    linkListener: () => listener,
    linkKnownHostsPath: () => join(temp, "known_hosts"),
    sshRunner: runner,
    revokeApiKey: () => { events.push("revoke"); return true; },
    now: () => 1_762_819_200_000,
  };
  const call = async (path: string, method = "GET", body?: unknown, principal: "admin-token" | "gui-session" | null = "admin-token",
    issuance: "pairing" | "tailscale-identity" | null = null) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = new Request(url, { method, headers: { host: "127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleManagementAPI(req, url, config, deps, principal ?? undefined, { isPaired: () => true, isCurrent: () => true, revokeCurrent: () => true },
      { trustedLoopback: true, guiSessionIssuance: issuance });
  };
  return { call, events, sshCalls, get store() { return current; } };
}

async function pollDone(h: ReturnType<typeof harness>, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await h.call(`/api/link/children/jobs/${jobId}`);
    const body = await response!.json() as { job: { state: string } };
    if (body.job.state === "done") return body.job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

describe("link child operations routes", () => {
  test("principal matrix", async () => {
    const h = harness();
    const body = { op: "observe", linkIds: [HUB] };
    const admin = await h.call("/api/link/children/operations", "POST", body);
    expect(admin?.status).toBe(202);
    await pollDone(h, ((await admin!.json()) as { job: { jobId: string } }).job.jobId);
    expect((await h.call("/api/link/children/operations", "POST", body, "gui-session", "pairing"))?.status).toBe(202);
    expect((await h.call("/api/link/children/operations", "POST", body, "gui-session", "tailscale-identity"))?.status).toBe(403);
    expect((await h.call("/api/link/children/jobs/ljob_0123456789abcdef", "GET", undefined, "admin-token", "tailscale-identity"))?.status).toBe(403);
    // The management gate answers a request without credentials 401 before any route runs.
    const unauthenticated = new Request("http://127.0.0.1/api/link/children/operations", { method: "POST", body: JSON.stringify(body) });
    expect(requireManagementAuth(unauthenticated, { available: true, token: `ocx_admin_${"a".repeat(43)}`, source: "environment",
      sessions: new Map(), pairingGrants: new Map() })?.status).toBe(401);
    // A principal this route does not admit (no session, no admin token) is refused by the route itself.
    expect((await h.call("/api/link/children/operations", "POST", body, null))?.status).toBe(403);
    expect((await h.call("/api/link/children/jobs/ljob_0123456789abcdef", "GET", undefined, null))?.status).toBe(403);
  });

  test("body validation", async () => {
    const h = harness();
    const many = Array.from({ length: 65 }, (_, index) => "lnk_" + index.toString(16).padStart(16, "0"));
    for (const body of [{ op: "observe", linkIds: [HUB], extra: 1 }, { op: "sync", linkIds: [HUB] }, { op: "observe", linkIds: many },
      { op: "observe", linkIds: ["lnk_bad"] }, { op: "observe", linkIds: [] }, { op: "observe", linkIds: [HUB, HUB] }, { op: "observe" }, "observe"]) {
      const response = await h.call("/api/link/children/operations", "POST", body);
      expect(response?.status).toBe(400);
      expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("invalid_body");
    }
    expect(h.sshCalls).toEqual([]);
  });

  test("unknown link → 404; a Child runtime → 409", async () => {
    const h = harness();
    const missing = await h.call("/api/link/children/operations", "POST", { op: "observe", linkIds: ["lnk_1111111111111111"] });
    expect(missing?.status).toBe(404);
    expect(((await missing!.json()) as { error: { code: string } }).error.code).toBe("link_not_found");
    const child = harness({ runtimeRole: "client" });
    const refused = await child.call("/api/link/children/operations", "POST", { op: "observe", linkIds: [HUB] });
    expect(refused?.status).toBe(409);
    expect(((await refused!.json()) as { error: { code: string } }).error.code).toBe("runtime_role_client");
  });

  test("second job on a held link → 409, busy inside a multi-link job", async () => {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const h = harness({ gate });
    const first = await h.call("/api/link/children/operations", "POST", { op: "observe", linkIds: [HUB] });
    expect(first?.status).toBe(202);
    const firstJob = ((await first!.json()) as { job: { jobId: string; state: string } }).job;
    expect(firstJob.state).toBe("running");
    const second = await h.call("/api/link/children/operations", "POST", { op: "observe", linkIds: [HUB] });
    expect(second?.status).toBe(409);
    expect(((await second!.json()) as { error: { code: string } }).error.code).toBe("link_operation_in_progress");
    const all = await h.call("/api/link/children/operations", "POST", { op: "observe", linkIds: "all" });
    const allJob = ((await all!.json()) as { job: { jobId: string; items: Array<{ linkId: string; state: string; reason: string | null }> } }).job;
    expect(allJob.items.find(item => item.linkId === HUB)).toMatchObject({ state: "busy", reason: "link-operation-in-progress" });
    open();
    await pollDone(h, firstJob.jobId);
    const done = await pollDone(h, allJob.jobId) as unknown as typeof allJob;
    expect(done.items.find(item => item.linkId === CLIENT)).toMatchObject({ state: "unsupported", reason: "child-initiated" });
    expect(h.sshCalls).toHaveLength(1);
  });

  test("job polling to done writes the observation and lastOperation", async () => {
    const h = harness();
    const response = await h.call("/api/link/children/operations", "POST", { op: "observe", linkIds: [HUB] });
    const { job } = await response!.json() as { job: { jobId: string; schema: string; op: string; trigger: string; restart: string } };
    expect(job).toMatchObject({ schema: "ocx.link.child-job/1", op: "observe", trigger: "manual", restart: "none" });
    expect(job.jobId).toMatch(/^ljob_[0-9a-f]{16}$/);
    const done = await pollDone(h, job.jobId) as unknown as { items: Array<Record<string, unknown>>; finishedAt: string | null };
    expect(done.items).toEqual([{ linkId: HUB, alias: "host-cdef", state: "succeeded", reason: null,
      startedAt: "2025-11-11T00:00:00.000Z", finishedAt: "2025-11-11T00:00:00.000Z" }]);
    const cached = readChildObservations().children[HUB];
    expect(cached).toMatchObject({ source: "plan", installedVersion: "2.97.0", installKind: "bun", updateRoute: "none", updateReason: "up-to-date",
      lastOperation: { op: "observe", jobId: job.jobId, state: "succeeded", reason: null } });
    expect((await h.call("/api/link/children/jobs/ljob_0000000000000000"))?.status).toBe(404);
    const invalid = await h.call("/api/link/children/jobs/job-1");
    expect(invalid?.status).toBe(400);
    expect(((await invalid!.json()) as { error: { code: string } }).error.code).toBe("invalid_job_id");
  });

  test("?children=1 adds child to Home rows only and nothing without the query", async () => {
    const h = harness({ full: true });
    const plain = await (await h.call("/api/link/status?compatibility=1&diagnostics=1"))!.json() as { links: Array<Record<string, unknown>> };
    const withChildren = await (await h.call("/api/link/status?compatibility=1&diagnostics=1&children=1"))!.json() as { links: Array<Record<string, unknown>> };
    expect(plain.links.every(row => !("child" in row))).toBe(true);
    expect(withChildren.links.map(row => { const { child: _child, ...rest } = row; return rest; })).toEqual(plain.links);
    const child = withChildren.links.find(row => row.id === HUB)!.child as Record<string, unknown>;
    expect(child).toMatchObject({ runningVersion: "2.96.0", installedVersion: null, installKind: null, update: { route: null, reason: null, observedAt: null },
      catalog: { state: "current", pulledAt: 1_762_000_000_000 }, codex: null, activity: { idle: true, inFlight: 0 }, activeJob: null, lastOperation: null });
    expect(Object.keys(child).sort()).toEqual(["activeJob", "activity", "catalog", "codex", "homeVersion", "installKind", "installedVersion",
      "lastOperation", "runningVersion", "update", "versionSkew"]);
    const standalone = harness({ links: [] });
    const empty = await (await standalone.call("/api/link/status?children=1"))!.json() as { role: string; links: unknown[] };
    expect(empty).toMatchObject({ role: "standalone", links: [] });
  });

  test("a held config lock during a children=1 read still returns 200 and the next read persists the revision", async () => {
    const h = harness({ full: true });
    const holder = new Database(join(temp, "ocx", "config-mutation.sqlite"), { create: true });
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // A fresh catalog this module's monitor has not seen, so this read computes and tries to persist a revision.
    writeFileSync(join(temp, "codex", "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fresh-" + temp.slice(-6) }] }));
    try {
      const held = await h.call("/api/link/status?children=1");
      expect(held?.status).toBe(200);
      const row = ((await held!.json()) as { links: Array<{ id: string; child: { catalog: { state: string; homeChangedAt: number | null } } }> }).links[0]!;
      expect(row.child.catalog.state).toBe("behind");
      expect(row.child.catalog.homeChangedAt).not.toBeNull();
      expect(readChildObservations().homeCatalog).toBeNull();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      warn.mockRestore();
    }
    expect((await h.call("/api/link/status?children=1"))?.status).toBe(200);
    expect(readChildObservations().homeCatalog?.etag).toBe(catalogEtag(JSON.stringify({ models: [{ slug: "fresh-" + temp.slice(-6) }] })));
  });

  test("DELETE /api/link/children/x is 404, not a link removal", async () => {
    const h = harness();
    const response = await h.call("/api/link/children/x", "DELETE");
    expect(response?.status).toBe(404);
    expect(h.events).toEqual([]);
    expect(h.store.links.map(record => record.id)).toEqual([HUB, CLIENT]);
  });

  test("a children=1 read flushes pending catalog pull writes; a plain read does not", async () => {
    let flushes = 0;
    const h = harness({ full: true, onFlush: () => { flushes += 1; } });
    expect((await h.call("/api/link/status?compatibility=1&diagnostics=1"))?.status).toBe(200);
    expect(flushes).toBe(0);
    expect((await h.call("/api/link/status?children=1"))?.status).toBe(200);
    expect(flushes).toBe(1);
  });
});
