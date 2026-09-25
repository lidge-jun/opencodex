import { describe, expect, test, spyOn } from "bun:test";
import { ClientLinkJoinError, joinHome, type ClientLinkJoinDeps } from "../../src/client/link-join";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { SshRunner } from "../../src/link/ssh-runner";

const LINK_ID = "lnk_0123456789abcdef";
const API_KEY_ID = "link-key-1";
const KEY = `ocx_data_${"a".repeat(40)}`;
const FINGERPRINT = `SHA256:${"a".repeat(32)}`;

function runnerFor(calls: string[][], issueResult = true): SshRunner {
  return {
    run: async argv => {
      calls.push([...argv]);
      if (argv.some(value => value.includes("issue"))) {
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

function tunnelFor(order: string[]) {
  return {
    pid: 123,
    exited: Promise.resolve(0),
    stop: async () => { order.push("stop-tunnel"); },
  };
}

function joinDeps(overrides: Partial<ClientLinkJoinDeps> = {}): ClientLinkJoinDeps {
  const calls = overrides.runner ? [] : [];
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
    ...overrides,
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

function context(options: {
  role?: "standalone" | "hub" | "client";
  principal?: ManagementContext["principal"];
  paired?: boolean;
  issuance?: ManagementContext["guiSessionIssuance"];
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
    config: { runtimeRole: options.role ?? "standalone" } as ManagementContext["config"],
    deps: options.deps ?? {},
    version: "test",
    principal: options.principal,
    sessionControl: { isPaired: () => options.paired === true },
    trustedLoopbackIngress: true,
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
          fetchImpl: async (_input, init) => {
            order.push(`readyz:${new Headers(init?.headers).get("x-opencodex-api-key") === KEY ? "key" : "missing"}`);
            return new Response(null, { status: 200 });
          },
          connect: (async () => { order.push("connect"); }) as typeof import("../../src/client/connect").connectClient,
          scheduleRestart: () => { order.push("restart"); },
        }, { alias: "home" })),
      },
    }), routeState());
    const responseBody = await response?.json();
    expect(response?.status).toBe(202);
    expect(responseBody).toEqual({ linkId: LINK_ID, alias: "home", restarting: true });
    expect(sidecar).toMatchObject({ linkId: LINK_ID, tunnelPort: 23456, peerListenerPort: 45678 });
    expect(order).toEqual(["write-state", "spawn-tunnel", "readyz:key", "connect", "stop-tunnel", "restart"]);
    expect(calls[0]?.some(value => value.includes("issue"))).toBe(true);
    expect(calls[0]?.some(value => value.includes("--json"))).toBe(true);
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
    expect(calls.filter(argv => argv.some(value => value.includes("revoke")))).toHaveLength(1);
    expect(cleared).toBe(true);
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
        spawnTunnel: () => ({ pid: 1, exited: Promise.resolve(0), stop: async () => { stopped += 1; } }),
        fetchImpl: async () => readiness === "unauthorized" ? new Response(null, { status: 401 }) : new Response(null, { status: 503 }),
      });
      await expect(joinHome(deps, { alias: "home" })).rejects.toMatchObject({
        code: readiness === "timeout" ? "join_tunnel_failed" : "admission_failed",
      });
      expect(calls.filter(argv => argv.some(value => value.includes("revoke")))).toHaveLength(1);
      expect(stopped).toBe(1);
      expect(cleared).toBe(1);
    }
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
        fetchImpl: async () => new Response(null, { status: 200 }),
        connect: (async () => { throw new Error(`connect failed ${KEY}`); }) as typeof import("../../src/client/connect").connectClient,
      }), { alias: "home" })).rejects.toMatchObject({ code: "join_connect_failed" });
    } finally {
      logs.mockRestore();
    }
    expect(calls.filter(argv => argv.some(value => value.includes("revoke")))).toHaveLength(1);
    expect(logs.mock.calls.flat().join(" ")).not.toContain(KEY);
  });

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
        if (argv.some(value => value.includes("issue"))) {
          order.push("issue");
          return { code: 0, stdout: JSON.stringify({ linkId: LINK_ID, apiKeyId: API_KEY_ID, key: KEY, listenerPort: 45678 }), stderr: "" };
        }
        if (argv.some(value => value.includes("revoke"))) {
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
      spawnTunnel: () => ({ pid: 1, exited: Promise.resolve(0), stop: async () => {} }),
      fetchImpl: async () => new Response(null, { status: 200 }),
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
          fetchImpl: async () => new Response(null, { status: 200 }),
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
