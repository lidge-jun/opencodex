import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinkCommand, type LinkStatusPayload } from "../../src/cli/link";
import { createLinkDiagnosticSink, type LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { attachLinkTunnelDiagnostics, projectLinkStatus } from "../../src/link/status-projection";
import type { LinkStore } from "../../src/link/store";
import { createLinkSupervisor, type LinkSupervisor } from "../../src/link/supervisor";
import { TUNNEL_CAUSES } from "../../src/link/tunnel-history";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = "lnk_0123456789abcdef";
const ALIAS = "child-mac.example";
const STALE_FORWARD = "Error: remote port forwarding failed for listen port 19002";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) removeTreeWithRetry(dir);
});

function link(): LinkStore["links"][number] {
  return {
    id: LINK_ID, alias: ALIAS, direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort: 19002, apiKeyId: "key-link-1", createdAt: "2026-09-25T00:00:00.000Z",
  };
}

function fakeRunner() {
  const children: Array<{ child: SshChild; exit: (code: number) => void; stderr: string }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const item = { stderr: "", exit, child: undefined as unknown as SshChild };
      item.child = {
        pid: 500 + children.length, argv: [...argv], exited,
        stderr: exited.then(() => item.stderr), kill: () => exit(143),
      };
      children.push(item);
      return item.child;
    },
  };
  return { runner, children };
}

/** Drive one supervisor with a manual clock and a manual timer; an exit settles before it returns. */
function harness(initial: LinkStore) {
  const fake = fakeRunner();
  const records: LinkDiagnosticRecord[] = [];
  let store = initial;
  let tick!: () => void;
  const clock = { now: 0 };
  const supervisor: LinkSupervisor = createLinkSupervisor({
    readStore: () => store, runner: fake.runner, now: () => clock.now, random: () => 0.5,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: callback => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; }, clearTimer: () => {},
    diagnostic: record => { records.push(record); },
  });
  const settle = async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); };
  const exitWith = async (index: number, stderr: string) => {
    fake.children[index]!.stderr = stderr;
    fake.children[index]!.exit(255);
    await settle();
  };
  const at = (ms: number) => { clock.now = ms; tick(); };
  return { supervisor, records, children: fake.children, clock, exitWith, at, setStore: (next: LinkStore) => { store = next; } };
}

function dto(supervisor: LinkSupervisor, store: LinkStore) {
  return attachLinkTunnelDiagnostics(projectLinkStatus(store, supervisor.status(), { state: "listening", port: 19001 },
    { runtimeRole: "standalone" }, { version: 1, entries: {} }), supervisor.status());
}

test("a Home tunnel refused by a stale remote forward keeps retrying and records why", async () => {
  const store: LinkStore = { version: 1, listenerPort: 19001, links: [link()] };
  const h = harness(store);
  h.supervisor.start();
  try {
    h.at(5_000);
    expect(h.supervisor.status()[0]!.state).toEqual({ kind: "connected", since: 5_000 });
    // The Home slept: its ssh died, and the Child's sshd still holds port 19002 for that session.
    h.clock.now = 10_000;
    await h.exitWith(0, "client_loop: send disconnect: Broken pipe");
    h.at(11_000);
    expect(h.children).toHaveLength(2);
    h.clock.now = 11_500;
    await h.exitWith(1, STALE_FORWARD);
    expect(h.supervisor.status()[0]!.state).toEqual({
      kind: "failed", since: 11_500, reason: "forward", retryAt: 71_500, inFlight: false, detail: "remote_forward_conflict",
    });
    // Every later attempt meets the same held port; the link keeps retrying on a doubling delay.
    h.at(71_500);
    h.clock.now = 72_000;
    await h.exitWith(2, STALE_FORWARD);
    expect(h.supervisor.status()[0]!.state).toMatchObject({ kind: "failed", retryAt: 192_000, retries: 1 });
    const failing = dto(h.supervisor, store).links[0]!;
    expect(failing).toMatchObject({ state: "failed", reason: "forward" });
    expect(failing.tunnel).toEqual({
      attempt: 2,
      nextRetryAt: new Date(192_000).toISOString(),
      lastTransition: { from: "failed", to: "failed", at: new Date(72_000).toISOString(), cause: "remote_forward_conflict" },
      lastFailure: { cause: "remote_forward_conflict", at: new Date(72_000).toISOString() },
    });
    // sshd dropped the dead session; the next retry holds the port and outlives its grace.
    h.at(192_000);
    expect(dto(h.supervisor, store).links[0]!.tunnel?.nextRetryAt).toBeNull();
    h.at(207_000);
    expect(h.supervisor.status()[0]!.state).toEqual({ kind: "connected", since: 207_000 });
    expect(dto(h.supervisor, store).links[0]!.tunnel).toMatchObject({
      attempt: 0, nextRetryAt: null, lastTransition: { from: "failed", to: "connected", cause: null },
      lastFailure: { cause: "remote_forward_conflict" },
    });

    expect(h.records.map(record => [record.previousState, record.state, record.outcome, record.attempt, record.retryAfterMs])).toEqual([
      ["idle", "connecting", "spawned", 1, undefined],
      ["connecting", "connected", "connected", 0, undefined],
      ["connected", "reconnecting", "network", 0, 1_000],
      ["reconnecting", "failed", "remote_forward_conflict", 1, 60_000],
      ["failed", "failed", "remote_forward_conflict", 2, 120_000],
      ["failed", "connected", "connected", 0, undefined],
    ]);
    expect(h.records.every(record => record.event === "tunnel_transition" && record.tunnelPort === 19002)).toBe(true);
    expect(JSON.stringify(h.records)).not.toContain(ALIAS);
  } finally {
    await h.supervisor.stop();
  }
  expect(h.records.at(-1)).toMatchObject({ previousState: "connected", state: "idle", outcome: "stopped" });
});

test("a Home link without a listener port is retried instead of failing for good", async () => {
  const store: LinkStore = { version: 1, listenerPort: null, links: [link()] };
  const h = harness(store);
  h.supervisor.start();
  try {
    expect(h.children).toHaveLength(0);
    expect(h.supervisor.status()[0]!.state).toEqual({ kind: "failed", since: 0, reason: "forward", retryAt: 60_000, inFlight: false });
    h.at(60_000);
    expect(h.supervisor.status()[0]!.state).toEqual({ kind: "failed", since: 0, reason: "forward", retryAt: 180_000, inFlight: false, retries: 1 });
    expect(h.records.map(record => record.outcome)).toEqual(["listener_unavailable", "listener_unavailable"]);
    // The listener comes back: the changed record starts a fresh attempt at once.
    h.setStore({ ...store, listenerPort: 19001 });
    await h.supervisor.reload();
    expect(h.children).toHaveLength(1);
    expect(h.supervisor.status()[0]!.state).toEqual({ kind: "connecting", since: 60_000 });
    expect(h.supervisor.status()[0]!.history).toMatchObject({ attempt: 1, lastFailure: null });
  } finally {
    await h.supervisor.stop();
  }
});

test("a changed host key stays terminal and is recorded once", async () => {
  const store: LinkStore = { version: 1, listenerPort: 19001, links: [link()] };
  const h = harness(store);
  h.supervisor.start();
  try {
    await h.exitWith(0, "Host key verification failed.");
    for (let at = 1_000; at <= 24 * 60 * 60_000; at += 60_000) h.at(at);
    expect(h.children).toHaveLength(1);
    expect(h.records.filter(record => record.outcome === "hostkey")).toHaveLength(1);
    expect(dto(h.supervisor, store).links[0]!.tunnel).toMatchObject({ nextRetryAt: null, lastFailure: { cause: "hostkey" } });
  } finally {
    await h.supervisor.stop();
  }
});

test("the diagnostics file keeps only the fixed tunnel fields", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-link-tunnel-diag-"));
  temps.push(configDir);
  const sink = createLinkDiagnosticSink({ configDir, now: () => 1_000 });
  sink({
    event: "tunnel_transition", outcome: "remote_forward_conflict", state: "failed", previousState: "reconnecting",
    attempt: 3, tunnelPort: 19002, retryAfterMs: 120_000,
    ...{ alias: ALIAS, argv: ["ssh", "-R", "127.0.0.1:19002:127.0.0.1:19001", "--", ALIAS], stderr: STALE_FORWARD },
  } as LinkDiagnosticRecord);
  sink({ event: "tunnel_transition", outcome: "connected", state: "connected", previousState: "bogus", tunnelPort: 70_000 } as LinkDiagnosticRecord);
  sink({ event: "tunnel_transition", outcome: "not-a-cause" } as unknown as LinkDiagnosticRecord);
  // Every cause the history can name is an allowed outcome; none is dropped as unknown.
  for (const cause of TUNNEL_CAUSES) sink({ event: "tunnel_transition", outcome: cause, state: "failed" });
  await sink.flush();
  const lines = readFileSync(join(configDir, "link", "diagnostics.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.slice(0, 2)).toEqual([
    { event: "tunnel_transition", outcome: "remote_forward_conflict", state: "failed", previousState: "reconnecting",
      attempt: 3, retryAfterMs: 120_000, tunnelPort: 19002, timestamp: 1_000 },
    { event: "tunnel_transition", outcome: "connected", state: "connected", timestamp: 1_000 },
  ]);
  // remote_forward_conflict was already written once in this one-second window.
  expect(lines.slice(2).map(line => line.outcome)).toEqual(TUNNEL_CAUSES.filter(cause => cause !== "remote_forward_conflict"));
});

function statusDeps(supervisor: LinkSupervisor, store: LinkStore): ManagementApiDeps {
  return {
    readLinkStore: () => store,
    linkSupervisor: () => supervisor,
    linkListener: () => ({
      ensureStarted: async () => {}, close: async () => {}, onAuthenticatedCatalog: () => () => {},
      status: () => ({ state: "listening", port: store.listenerPort, reason: null }),
    }),
  } as unknown as ManagementApiDeps;
}

async function getStatus(path: string, deps: ManagementApiDeps): Promise<Record<string, unknown>> {
  const url = new URL(`http://127.0.0.1${path}`);
  const config = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] } as unknown as OcxConfig;
  const response = await handleManagementAPI(new Request(url, { headers: { host: "127.0.0.1" } }), url, config, deps, "admin-token",
    { isPaired: () => true, isCurrent: () => true, revokeCurrent: () => true }, { trustedLoopback: true, guiSessionIssuance: null });
  expect(response?.status).toBe(200);
  return await response!.json() as Record<string, unknown>;
}

test("GET /api/link/status adds tunnel diagnostics only on request, and ocx link status validates them", async () => {
  const store: LinkStore = { version: 1, listenerPort: 19001, links: [link()] };
  const h = harness(store);
  h.supervisor.start();
  try {
    await h.exitWith(0, STALE_FORWARD);
    const deps = statusDeps(h.supervisor, store);
    const plain = await getStatus("/api/link/status", deps);
    expect(Object.keys((plain.links as object[])[0]!)).not.toContain("tunnel");
    const detailed = await getStatus("/api/link/status?compatibility=1&diagnostics=1", deps);
    const tunnel = { attempt: 1, nextRetryAt: new Date(60_000).toISOString(), lastTransition: { from: "connecting", to: "failed",
      at: new Date(0).toISOString(), cause: "remote_forward_conflict" }, lastFailure: { cause: "remote_forward_conflict", at: new Date(0).toISOString() } };
    expect((detailed.links as Array<Record<string, unknown>>)[0]!.tunnel).toEqual(tunnel);

    const printed: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
    try {
      const fetchImpl = (async () => Response.json(detailed)) as unknown as typeof fetch;
      expect(await runLinkCommand(["status", "--json"], { baseUrl: "http://127.0.0.1:19101", fetchImpl, readAdminToken: () => "ocx_admin_t" })).toBe(0);
      expect((JSON.parse(printed[0]!) as LinkStatusPayload).links[0]!.tunnel).toEqual(tunnel);
      for (const bad of [{ ...tunnel, stderr: STALE_FORWARD }, { ...tunnel, lastFailure: { cause: STALE_FORWARD, at: tunnel.lastFailure.at } }, { ...tunnel, attempt: -1 }]) {
        const body = { ...detailed, links: [{ ...(detailed.links as object[])[0]!, tunnel: bad }] };
        const badFetch = (async () => Response.json(body)) as unknown as typeof fetch;
        expect(await runLinkCommand(["status", "--json"], { baseUrl: "http://127.0.0.1:19101", fetchImpl: badFetch, readAdminToken: () => "ocx_admin_t" })).not.toBe(0);
      }
    } finally {
      console.log = original;
    }
  } finally {
    await h.supervisor.stop();
  }
});
