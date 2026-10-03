import { describe, expect, test, spyOn } from "bun:test";
import { chooseJoinTunnelPort, ClientLinkJoinError, joinHome, type ClientLinkJoinDeps } from "../../src/client/link-join";
import { spawnClientLinkTunnel } from "../../src/client/link-tunnel";
import type { ListenPidScan } from "../../src/server/port-reclaim";
import { isLinkPort, JOIN_TUNNEL_PORT_MAX, JOIN_TUNNEL_PORT_MIN } from "../../src/link/ports";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { SshRunner } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv } from "../../src/link/ssh-argv";

const LINK_ID = "lnk_0123456789abcdef";
const REVOKE_COMMAND = quoteRemote(remoteOcxArgv(["link", "revoke", "--link-id", LINK_ID]));

/** The issue command up to its variable arguments, wrapped in the remote PATH prelude. */
function isWrappedIssue(argv: readonly string[]): boolean {
  return (argv.at(-1) ?? "").startsWith(`${quoteRemote(remoteOcxArgv(["link", "issue", "--alias"]))} `);
}

/** Select only the wrapped revoke command, not other SSH traffic. */
function revokeCalls(calls: readonly string[][]): string[][] {
  return calls.filter(argv => argv.at(-1) === REVOKE_COMMAND);
}
const API_KEY_ID = "link-key-1";
const KEY = `ocx_data_${"a".repeat(40)}`;
const FINGERPRINT = `SHA256:${"a".repeat(32)}`;

/** Record issue and compensation calls without starting an SSH process. */
function runnerFor(calls: string[][], issueResult = true): SshRunner {
  return {
    run: async argv => {
      calls.push([...argv]);
      if (isWrappedIssue(argv)) {
        return issueResult
          ? { code: 0, stdout: JSON.stringify({ linkId: LINK_ID, apiKeyId: API_KEY_ID, key: KEY, listenerPort: 45678 }), stderr: "" }
          : { code: 1, stdout: "", stderr: "failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawnTunnel: () => ({
      pid: 123,
      argv: [],
      exited: Promise.resolve(0),
      kill: () => {},
    }),
  };
}

/** Keep the fake tunnel alive until its owner stops it. */
function tunnelFor(order: string[]) {
  return {
    pid: 123,
    exited: new Promise<number>(() => {}),
    stop: async () => { order.push("stop-tunnel"); },
  };
}

/** Return the link-auth challenge before accepting the issued key. */
function challengedFetch(order?: string[]) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const authed = new Headers(init?.headers).get("x-opencodex-api-key") === KEY;
    order?.push(authed ? "readyz:key" : "readyz:probe");
    return new Response(null, { status: authed ? 200 : 401 });
  };
}

/** Supply isolated join dependencies and attribute the listener to the fake tunnel. */
function joinDeps(overrides: Partial<ClientLinkJoinDeps> = {}): ClientLinkJoinDeps {
  const calls: string[][] = [];
  let tunnelPid = 0;
  const spawn = overrides.spawnTunnel ?? spawnClientLinkTunnel;
  return {
    runner: overrides.runner ?? runnerFor(calls),
    knownHostsFile: "/tmp/ocx-known-hosts",
    confirmedHost: { alias: "home", fingerprint: FINGERPRINT, probedAt: 0 },
    choosePort: async () => 23456,
    now: () => 1,
    sleep: async () => {},
    hostname: () => "client-host",
    readSidecar: () => null,
    readConnectionState: () => ({ kind: "disconnected" }),
    scheduleRestart: () => {},
    ...overrides,
    spawnTunnel: (spec, spawnDeps) => {
      const handle = spawn(spec, spawnDeps);
      tunnelPid = handle.pid;
      return handle;
    },
    scanListenPids: overrides.scanListenPids ?? (() => ({ ok: true, pids: [tunnelPid] })),
  };
}

function routeState(confirmed = true): LinkRouteState {
  return {
    pendingHosts: new Map(),
    confirmedHosts: confirmed
      ? new Map([["home", { alias: "home", fingerprint: FINGERPRINT, keyType: "ed25519", knownHostLine: "home ssh-ed25519 AAAA", probedAt: 0, ocxVersion: "2.0.0" }]])
      : new Map(),
    supervisor: {} as LinkRouteState["supervisor"],
    listener: {} as LinkRouteState["listener"],
  };
}

const CONFIG_PORT = 10100;

function context(options: {
  role?: "standalone" | "hub" | "client";
  principal?: ManagementContext["principal"];
  paired?: boolean;
  current?: boolean;
  issuance?: ManagementContext["guiSessionIssuance"];
  trustedLoopback?: boolean;
  livePort?: number;
  body?: unknown;
  deps?: Record<string, unknown>;
} = {}): ManagementContext {
  const body = options.body ?? { alias: "home" };
  const req = new Request("http://127.0.0.1/api/link/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    req,
    url: new URL(req.url),
    config: { runtimeRole: options.role ?? "standalone", port: CONFIG_PORT } as ManagementContext["config"],
    deps: { liveListenPort: () => options.livePort ?? CONFIG_PORT, ...options.deps },
    version: "test",
    principal: options.principal,
    sessionControl: { isPaired: () => options.paired === true, isCurrent: () => options.current ?? true, revokeCurrent: () => true },
    trustedLoopbackIngress: options.trustedLoopback ?? true,
    guiSessionIssuance: options.issuance ?? null,
    convergeCodexCatalog: async () => ({ status: "unchanged" } as never),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("client initiated link join", () => {
  test("rejects unauthenticated, Tailscale, and non-standalone requests before lifecycle state", async () => {
    const state = routeState();
    const unauthenticated = await handleLinkRoutes(context(), state);
    expect(unauthenticated?.status).toBe(403);

    const tailscale = await handleLinkRoutes(context({ issuance: "tailscale-identity", principal: "gui-session", paired: true }), state);
    expect(tailscale?.status).toBe(403);
    expect(await tailscale?.json()).toMatchObject({ error: { code: "tailscale_session_refused" } });

    for (const role of ["hub", "client"] as const) {
      const response = await handleLinkRoutes(context({ role, principal: "gui-session", paired: true }), state);
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ error: { code: "standalone_required" } });
    }
  });

  test("requires an operator-paired dashboard session before joining", async () => {
    let joins = 0;
    const deps = { joinHome: async () => { joins += 1; return { linkId: LINK_ID, apiKeyId: API_KEY_ID }; } };
    const loopback = { principal: "gui-session" as const, issuance: "loopback" as const, deps };
    const credentialless = await handleLinkRoutes(context({ ...loopback, trustedLoopback: true }), routeState());
    expect(credentialless?.status).toBe(403);
    expect(joins).toBe(0);

    for (const options of [
      { role: "standalone" as const, trustedLoopback: true, current: false },
      { role: "standalone" as const, trustedLoopback: false },
      { role: "hub" as const, trustedLoopback: true },
      { role: "client" as const, trustedLoopback: true },
    ]) {
      const response = await handleLinkRoutes(context({ ...loopback, ...options }), routeState());
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ error: { code: "forbidden" } });
    }
    const tailscale = await handleLinkRoutes(context({ ...loopback, issuance: "tailscale-identity" }), routeState());
    expect(tailscale?.status).toBe(403);
    expect(await tailscale?.json()).toMatchObject({ error: { code: "tailscale_session_refused" } });
    expect(joins).toBe(0);

    const paired = await handleLinkRoutes(context({ principal: "gui-session", issuance: "pairing", paired: true, deps }), routeState());
    expect(paired?.status).toBe(202);
    expect(joins).toBe(1);
  });

  test("refuses a join whose restart could not bind the configured port, before any SSH", async () => {
    const calls: string[][] = [];
    let joins = 0;
    const deps = {
      sshRunner: runnerFor(calls),
      joinHome: async () => { joins += 1; return { linkId: LINK_ID, apiKeyId: API_KEY_ID }; },
    };
    for (const livePort of [CONFIG_PORT + 1, undefined]) {
      const response = await handleLinkRoutes({
        ...context({ principal: "gui-session", issuance: "pairing", paired: true, deps }),
        deps: { ...deps, liveListenPort: () => livePort },
      }, routeState());
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ error: { code: "join_port_mismatch" } });
    }
    expect(joins).toBe(0);
    expect(calls).toEqual([]);
  });

  test("maps a missing ocx on Home to remote_ocx_missing with a redacted stderr hint", async () => {
    const calls: string[][] = [];
    const runner: SshRunner = {
      run: async argv => {
        calls.push([...argv]);
        return isWrappedIssue(argv)
          ? { code: 127, stdout: "", stderr: `sh: 1: exec: ocx: not found ${KEY}\n` }
          : { code: 0, stdout: "", stderr: "" };
      },
      spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill: () => {} }),
    };
    const response = await handleLinkRoutes(context({
      principal: "gui-session",
      paired: true,
      deps: {
        sshRunner: runner,
        linkKnownHostsPath: () => "/tmp/ocx-known-hosts",
        joinHome: (async (deps, input) => joinHome({
          ...deps,
          choosePort: async () => 23456,
          now: () => 1,
          readSidecar: () => null,
          readConnectionState: () => ({ kind: "disconnected" }),
        }, input)) as typeof import("../../src/client/link-join").joinHome,
      },
    }), routeState());
    expect(response?.status).toBe(502);
    expect(await response?.json()).toEqual({
      error: { code: "remote_ocx_missing", message: "ocx was not found on the home.", hint: "sh: 1: exec: ocx: not found ocx_data_[redacted]" },
    });
    expect(calls.filter(isWrappedIssue)).toHaveLength(1);
  });

  test("requires the exact body and a confirmed host", async () => {
    const exact = await handleLinkRoutes(context({ principal: "gui-session", paired: true, body: { alias: "home", extra: true } }), routeState());
    expect(exact?.status).toBe(400);

    const missing = await handleLinkRoutes(context({ principal: "gui-session", paired: true }), routeState(false));
    expect(missing?.status).toBe(409);
    expect(await missing?.json()).toMatchObject({ error: { code: "host_not_confirmed" } });
  });

  test("allows only one join for a runtime at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deps = {
      joinHome: async () => {
        await gate;
        return { linkId: LINK_ID, apiKeyId: API_KEY_ID };
      },
    };
    const first = context({ principal: "gui-session", paired: true, deps });
    const second = context({ principal: "gui-session", paired: true, deps });
    second.config = first.config;
    const pending = handleLinkRoutes(first, routeState());
    await Promise.resolve();
    const duplicate = await handleLinkRoutes(second, routeState());
    expect(duplicate?.status).toBe(409);
    expect(await duplicate?.json()).toMatchObject({ error: { code: "join_in_progress" } });
    release();
    expect((await pending)?.status).toBe(202);
  });

  test("runs issue, sidecar, tunnel readiness, connect, stop, and restart in order", async () => {
    const order: string[] = [];
    const calls: string[][] = [];
    const sidecar: Record<string, unknown> = {};
    const response = await handleLinkRoutes(context({
      principal: "gui-session",
      paired: true,
      deps: {
        sshRunner: runnerFor(calls),
        linkKnownHostsPath: () => "/tmp/ocx-known-hosts",
        joinHome: (async deps => joinHome({
          ...deps,
          choosePort: async () => 23456,
          now: () => 1,
          sleep: async () => {},
          hostname: () => "client-host",
          writeState: state => { order.push("write-state"); Object.assign(sidecar, state); },
          spawnTunnel: () => { order.push("spawn-tunnel"); return tunnelFor(order); },
          scanListenPids: () => ({ ok: true, pids: [123] }),
          fetchImpl: challengedFetch(order),
          connect: (async () => { order.push("connect"); }) as typeof import("../../src/client/connect").connectClient,
          scheduleRestart: () => { order.push("restart"); },
        }, { alias: "home" })),
      },
    }), routeState());
    const responseBody = await response?.json();
    expect(response?.status).toBe(202);
    expect(responseBody).toEqual({ linkId: LINK_ID, alias: "home", restarting: true });
    expect(sidecar).toMatchObject({ linkId: LINK_ID, tunnelPort: 23456, peerListenerPort: 45678 });
    expect(order).toEqual(["write-state", "spawn-tunnel", "readyz:probe", "readyz:key", "connect", "stop-tunnel", "restart"]);
    expect(isWrappedIssue(calls[0] ?? [])).toBe(true);
    expect(calls[0]?.at(-1)?.endsWith(" '--json'")).toBe(true);
  });

  test("rolls back sidecar and remote issue when sidecar write fails", async () => {
    const calls: string[][] = [];
    let cleared = false;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      writeState: () => { throw new Error("sidecar write failed"); },
      clearState: () => { cleared = true; },
      spawnTunnel: () => { throw new Error("must not start"); },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(revokeCalls(calls)).toHaveLength(1);
    expect(cleared).toBe(true);
  });

  test("picks the join tunnel port from 20000-29999, outside the OS ephemeral ranges", async () => {
    const calls: string[][] = [];
    let sidecarPort = 0;
    await joinHome(joinDeps({
      runner: runnerFor(calls),
      choosePort: undefined,
      writeState: state => { sidecarPort = state.tunnelPort; },
      spawnTunnel: () => tunnelFor([]),
      fetchImpl: challengedFetch(),
      connect: (async () => {}) as typeof import("../../src/client/connect").connectClient,
      scheduleRestart: () => {},
    }), { alias: "home" });
    const issue = calls.find(isWrappedIssue)?.at(-1) ?? "";
    const port = Number(/'--tunnel-port' '(\d+)'/.exec(issue)?.[1]);
    expect(port).toBe(sidecarPort);
    expect(port).toBeGreaterThanOrEqual(JOIN_TUNNEL_PORT_MIN);
    expect(port).toBeLessThanOrEqual(JOIN_TUNNEL_PORT_MAX);
    expect(isLinkPort(port)).toBe(true);

    const tried: number[] = [];
    const picked = await chooseJoinTunnelPort({
      isAvailable: async candidate => { tried.push(candidate); return tried.length === 3; },
      random: () => 0.999_999_9,
    });
    expect(picked).toBe(JOIN_TUNNEL_PORT_MAX);
    expect(tried).toHaveLength(3);
    await expect(chooseJoinTunnelPort({ isAvailable: async () => false })).rejects.toThrow("join tunnel range");
  });

  test("rolls back on readiness timeout and admission rejection", async () => {
    for (const readiness of ["timeout", "unauthorized"] as const) {
      const calls: string[][] = [];
      let stopped = 0;
      let cleared = 0;
      let ticks = 0;
      const deps = joinDeps({
        runner: runnerFor(calls),
        now: () => readiness === "timeout" ? (ticks++ === 0 ? 0 : 15_002 * ticks) : 1,
        sleep: async () => {},
        writeState: () => {},
        clearState: () => { cleared += 1; },
        spawnTunnel: () => ({ pid: 1, exited: new Promise<number>(() => {}), stop: async () => { stopped += 1; } }),
        fetchImpl: async () => readiness === "unauthorized" ? new Response(null, { status: 401 }) : new Response(null, { status: 503 }),
      });
      await expect(joinHome(deps, { alias: "home" })).rejects.toMatchObject({
        code: readiness === "timeout" ? "join_tunnel_failed" : "admission_failed",
      });
      expect(revokeCalls(calls)).toHaveLength(1);
      expect(stopped).toBe(1);
      expect(cleared).toBe(1);
    }
  });

  test("never sends the issued key to a listener that skips the link-auth challenge", async () => {
    const calls: string[][] = [];
    let keyedFetches = 0;
    let ticks = 0;
    let stopped = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => (ticks++ === 0 ? 0 : 15_002 * ticks),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 1, exited: new Promise<number>(() => {}), stop: async () => { stopped += 1; } }),
      fetchImpl: async (_input, init) => {
        if (new Headers(init?.headers).has("x-opencodex-api-key")) keyedFetches += 1;
        return new Response(null, { status: 200 });
      },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(keyedFetches).toBe(0);
    expect(stopped).toBe(1);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("a squatter answering the 401 challenge never receives the issued key", async () => {
    const calls: string[][] = [];
    let keyedFetches = 0;
    let ticks = 0;
    let stopped = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => (ticks++ === 0 ? 0 : 15_002 * ticks),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 123, exited: new Promise<number>(() => {}), stop: async () => { stopped += 1; } }),
      // A live SSH process alone does not prove ownership of the listener.
      scanListenPids: () => ({ ok: true, pids: [999] }),
      fetchImpl: async (_input, init) => {
        if (new Headers(init?.headers).has("x-opencodex-api-key")) keyedFetches += 1;
        return new Response(null, { status: 401 });
      },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(keyedFetches).toBe(0);
    expect(stopped).toBe(1);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("the readiness scan is scoped to the tunnel's loopback address", async () => {
    const seenAddresses: Array<string | undefined> = [];
    const order: string[] = [];
    await joinHome(joinDeps({
      runner: runnerFor([]),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => tunnelFor(order),
      scanListenPids: (_port, address) => {
        seenAddresses.push(address);
        return { ok: true, pids: [123] };
      },
      fetchImpl: challengedFetch(order),
      connect: (async () => {}) as never,
      scheduleRestart: () => {},
    }), { alias: "home" });
    expect(seenAddresses.length).toBeGreaterThan(0);
    for (const address of seenAddresses) expect(address).toBe("127.0.0.1");
  });

  test("a port flip between the probe and the keyed request never receives the key", async () => {
    const calls: string[][] = [];
    let keyedFetches = 0;
    let ticks = 0;
    let scans = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => (ticks++ === 0 ? 0 : 15_002 * ticks),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 123, exited: new Promise<number>(() => {}), stop: async () => {} }),
      scanListenPids: () => ({ ok: true, pids: scans++ === 0 ? [123] : [999] }),
      fetchImpl: async (_input, init) => {
        if (new Headers(init?.headers).has("x-opencodex-api-key")) keyedFetches += 1;
        return new Response(null, { status: 401 });
      },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(keyedFetches).toBe(0);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("a redirect on the readiness probe is never followed with the issued key", async () => {
    const calls: string[][] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    let keyedFetches = 0;
    let ticks = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => (ticks++ === 0 ? 0 : 15_002 * ticks),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 123, exited: new Promise<number>(() => {}), stop: async () => {} }),
      fetchImpl: async (_input, init) => {
        redirects.push(init?.redirect);
        if (new Headers(init?.headers).has("x-opencodex-api-key")) keyedFetches += 1;
        return new Response(null, { status: 302, headers: { location: "http://169.254.1.1/fake-readyz" } });
      },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(redirects).toEqual(["manual"]);
    expect(keyedFetches).toBe(0);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("readiness polling stops after tunnel exit without waiting for its deadline", async () => {
    const calls: string[][] = [];
    let clock = 1, scans = 0, sleeps = 0, fetched = 0, connected = 0;
    let releaseExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { releaseExit = resolve; });
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => clock,
      sleep: async ms => {
        sleeps += 1; clock += ms; releaseExit(255);
        await Promise.resolve();
      },
      writeState: () => {}, clearState: () => {},
      spawnTunnel: () => ({ pid: 123, exited, stop: async () => {} }),
      scanListenPids: () => { scans += 1; return { ok: true, pids: [] }; },
      fetchImpl: async () => { fetched += 1; return new Response(null, { status: 401 }); },
      connect: (async () => { connected += 1; }) as typeof import("../../src/client/connect").connectClient,
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(scans).toBe(1);
    expect(sleeps).toBe(1);
    expect(clock).toBe(101);
    expect(fetched).toBe(0);
    expect(connected).toBe(0);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("a tunnel that exits during connect cannot commit the connection", async () => {
    const calls: string[][] = [];
    let releaseExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { releaseExit = resolve; });
    let stopped = 0;
    let connectCommitted = false;
    let connectDrained = false;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 1, exited, stop: async () => { stopped += 1; } }),
      fetchImpl: challengedFetch(),
      connect: (async (_options, deps) => {
        releaseExit(255);
        try {
          await new Promise(resolve => setTimeout(resolve, 10));
          deps?.signal?.throwIfAborted();
          connectCommitted = true;
        } finally { connectDrained = true; }
      }) as typeof import("../../src/client/connect").connectClient,
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(connectDrained).toBe(true);
    expect(connectCommitted).toBe(false);
    expect(stopped).toBe(1);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  test("an exit queued after enrollment commit does not revoke the committed link", async () => {
    const calls: string[][] = [], order: string[] = [];
    let releaseExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { releaseExit = resolve; });
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      writeState: () => {}, clearState: () => { order.push("clear"); },
      spawnTunnel: () => ({ pid: 123, exited, stop: async () => { order.push("stop"); } }),
      fetchImpl: challengedFetch(),
      connect: (async (_options, deps) => {
        deps?.signal?.throwIfAborted();
        // Mirrors connectClient's synchronous final commit: no await follows it.
        order.push("commit");
        releaseExit(255);
      }) as typeof import("../../src/client/connect").connectClient,
      scheduleRestart: () => { order.push("restart"); },
    }), { alias: "home" })).resolves.toEqual({ linkId: LINK_ID, apiKeyId: API_KEY_ID });
    expect(order).toEqual(["commit", "stop", "restart"]);
    expect(revokeCalls(calls)).toHaveLength(0);
  });

  test("does not disclose the issued key when the tunnel exits during its spawn grace", async () => {
    const calls: string[][] = [];
    let fetches = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      writeState: () => {},
      clearState: () => {},
      spawnTunnel: () => ({ pid: 1, exited: Promise.resolve(255), stop: async () => {} }),
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
    expect(fetches).toBe(0);
    expect(revokeCalls(calls)).toHaveLength(1);
  });

  for (const { name, recheck } of [
    { name: "unavailable", recheck: { ok: false, error: "scanner unavailable" } },
    { name: "empty", recheck: { ok: true, pids: [] } },
    { name: "foreign", recheck: { ok: true, pids: [999] } },
    { name: "ambiguous", recheck: { ok: true, pids: [123, 999] } },
  ] satisfies Array<{ name: string; recheck: ListenPidScan }>) {
    test(`repeated ${name} rechecks reach the readiness deadline and revoke the key`, async () => {
      const calls: string[][] = [];
      const sleeps: number[] = [];
      let clock = 1;
      let scans = 0;
      let keyedFetches = 0;
      let stopped = 0;
      let cleared = 0;
      let connected = 0;
      let restarted = 0;
      await expect(joinHome(joinDeps({
        runner: runnerFor(calls),
        now: () => clock,
        sleep: async ms => { sleeps.push(ms); clock += ms; },
        writeState: () => {},
        clearState: () => { cleared += 1; },
        spawnTunnel: () => ({ pid: 123, exited: new Promise<number>(() => {}), stop: async () => { stopped += 1; } }),
        scanListenPids: () => {
          // Terminate the broken implementation without hanging the test runner.
          // Its bypassed deadline produces the wrong error, so this is not a pass.
          if (++scans > 400) throw new ClientLinkJoinError("admission_failed");
          return scans % 2 === 1 ? { ok: true, pids: [123] } : recheck;
        },
        fetchImpl: async (_input, init) => {
          if (new Headers(init?.headers).has("x-opencodex-api-key")) keyedFetches += 1;
          return new Response(null, { status: 401 });
        },
        connect: (async () => { connected += 1; }) as typeof import("../../src/client/connect").connectClient,
        scheduleRestart: () => { restarted += 1; },
      }), { alias: "home" })).rejects.toMatchObject({ code: "join_tunnel_failed" });
      expect(clock).toBe(15_001);
      expect(sleeps).toHaveLength(150);
      expect(sleeps.every(ms => ms === 100)).toBe(true);
      expect(scans).toBe(302);
      expect(keyedFetches).toBe(0);
      expect(connected).toBe(0);
      expect(restarted).toBe(0);
      expect(stopped).toBe(1);
      expect(cleared).toBe(1);
      expect(revokeCalls(calls)).toHaveLength(1);
    });
  }

  test("a transient failed recheck polls before retrying and can still join", async () => {
    const calls: string[][] = [];
    const order: string[] = [];
    let clock = 1;
    let scans = 0;
    await expect(joinHome(joinDeps({
      runner: runnerFor(calls),
      now: () => clock,
      sleep: async ms => { clock += ms; order.push(`sleep:${ms}`); },
      writeState: () => {},
      spawnTunnel: () => tunnelFor(order),
      scanListenPids: () => ++scans === 2
        ? { ok: false, error: "transient" }
        : { ok: true, pids: [123] },
      fetchImpl: challengedFetch(order),
      connect: (async () => { order.push("connect"); }) as typeof import("../../src/client/connect").connectClient,
      scheduleRestart: () => { order.push("restart"); },
    }), { alias: "home" })).resolves.toEqual({ linkId: LINK_ID, apiKeyId: API_KEY_ID });
    expect(scans).toBe(4);
    expect(order).toEqual(["readyz:probe", "sleep:100", "readyz:probe", "readyz:key", "connect", "stop-tunnel", "restart"]);
    expect(revokeCalls(calls)).toHaveLength(0);
  });

  test("rolls back on connect failure and never exposes the issued key", async () => {
    const calls: string[][] = [];
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(joinHome(joinDeps({
        runner: runnerFor(calls),
        writeState: () => {},
        clearState: () => {},
        spawnTunnel: () => tunnelFor([]),
        fetchImpl: challengedFetch(),
        connect: (async () => { throw new Error(`connect failed ${KEY}`); }) as typeof import("../../src/client/connect").connectClient,
      }), { alias: "home" })).rejects.toMatchObject({ code: "join_connect_failed" });
    } finally {
      logs.mockRestore();
    }
    expect(revokeCalls(calls)).toHaveLength(1);
    expect(logs.mock.calls.flat().join(" ")).not.toContain(KEY);
  });

  for (const code of ["join_connect_failed", "admission_failed"] as const) {
    test(`rollback tunnel exit preserves the original ${code} cause`, async () => {
      const calls: string[][] = [];
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      let stopped = 0, cleared = 0;
      await expect(joinHome(joinDeps({
        runner: runnerFor(calls), writeState: () => {},
        clearState: () => { cleared += 1; },
        spawnTunnel: () => ({ pid: 123, exited, stop: async () => { stopped += 1; exit(0); } }),
        fetchImpl: challengedFetch(),
        connect: (async () => {
          if (code === "admission_failed") throw new ClientLinkJoinError(code);
          throw new Error("catalog validation failed");
        }) as typeof import("../../src/client/connect").connectClient,
      }), { alias: "home" })).rejects.toMatchObject({ code });
      expect(stopped).toBe(1);
      expect(cleared).toBe(1);
      expect(revokeCalls(calls)).toHaveLength(1);
    });
  }

  test("keeps the sidecar and reports the link id when rollback revoke fails, then compensates before the next join", async () => {
    const sidecar = {
      linkId: LINK_ID,
      alias: "home",
      hubHostKeyFingerprint: FINGERPRINT,
      peerListenerPort: 45678,
      tunnelPort: 23456,
    };
    let sidecarPresent = false;
    let revokeCount = 0;
    const order: string[] = [];
    const runner: SshRunner = {
      run: async argv => {
        if (isWrappedIssue(argv)) {
          order.push("issue");
          return { code: 0, stdout: JSON.stringify({ linkId: LINK_ID, apiKeyId: API_KEY_ID, key: KEY, listenerPort: 45678 }), stderr: "" };
        }
        if (argv.at(-1) === REVOKE_COMMAND) {
          revokeCount += 1;
          order.push(`revoke-${revokeCount}`);
          return { code: revokeCount === 1 ? 1 : 0, stdout: "", stderr: "failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      spawnTunnel: () => ({ pid: 1, argv: [], exited: Promise.resolve(0), kill: () => {} }),
    };
    const base = joinDeps({
      runner,
      readSidecar: () => sidecarPresent ? sidecar : null,
      writeState: value => { sidecarPresent = true; Object.assign(sidecar, value); },
      clearState: () => { sidecarPresent = false; },
      spawnTunnel: () => ({ pid: 1, exited: new Promise<number>(() => {}), stop: async () => {} }),
      fetchImpl: challengedFetch(),
      connect: (async () => { throw new Error("connect failed"); }) as typeof import("../../src/client/connect").connectClient,
    });
    await expect(joinHome(base, { alias: "home" })).rejects.toMatchObject({ code: "join_rollback_failed", linkId: LINK_ID });
    expect(sidecarPresent).toBe(true);

    const next = joinDeps({
      ...base,
      connect: (async () => {}) as typeof import("../../src/client/connect").connectClient,
      scheduleRestart: () => {},
    });
    await expect(joinHome(next, { alias: "home" })).resolves.toEqual({ linkId: LINK_ID, apiKeyId: API_KEY_ID });
    expect(order).toEqual(["issue", "revoke-1", "revoke-2", "issue"]);
    expect(sidecarPresent).toBe(true);
  });

  test("maps a restart scheduling failure to 500 while retaining the committed connection and sidecar", async () => {
    let connected = false;
    let sidecar: Record<string, unknown> = {};
    let cleared = false;
    const response = await handleLinkRoutes(context({
      principal: "gui-session",
      paired: true,
      deps: {
        sshRunner: runnerFor([]),
        joinHome: (async (deps, input) => joinHome({
          ...deps,
          readSidecar: () => null,
          readConnectionState: () => ({ kind: "disconnected" }),
          now: () => 1,
          writeState: state => { sidecar = { ...state }; },
          clearState: () => { cleared = true; },
          spawnTunnel: () => tunnelFor([]),
          scanListenPids: () => ({ ok: true, pids: [123] }),
          fetchImpl: challengedFetch(),
          connect: (async () => { connected = true; }) as typeof import("../../src/client/connect").connectClient,
          scheduleRestart: () => { throw new Error("restart unavailable"); },
        }, input)) as typeof import("../../src/client/link-join").joinHome,
      },
    }), routeState());
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      error: { code: "join_restart_failed", message: "The link is ready; restart OpenCodex to finish connecting as a Child." },
    });
    expect(connected).toBe(true);
    expect(sidecar).toMatchObject({ linkId: LINK_ID });
    expect(cleared).toBe(false);
  });

  test("maps rollback failure with its link id and preserves the remote compensation receipt", async () => {
    const response = await handleLinkRoutes(context({
      principal: "gui-session",
      paired: true,
      deps: {
        joinHome: async () => { throw new ClientLinkJoinError("join_rollback_failed", LINK_ID); },
      },
    }), routeState());
    expect(response?.status).toBe(502);
    expect(await response?.json()).toEqual({
      error: {
        code: "join_rollback_failed",
        message: `The join failed and the home link could not be revoked; run ocx link revoke --link-id ${LINK_ID} on the home.`,
      },
    });
  });
});
