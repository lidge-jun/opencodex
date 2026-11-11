import { describe, expect, test } from "bun:test";
import { bindRestartToPid, restartRuntimeAfterDisconnect, type DisconnectRuntimeDeps } from "../../src/cli/disconnect-runtime";
import { runProxyRestart, type ProxyRestartIo } from "../../src/cli/tray-proxy";

type Observation = Awaited<ReturnType<DisconnectRuntimeDeps["observe"]>>;
const live = (role?: string): Observation => ({ kind: "live", live: { pid: 4321, ...(role ? { role } : {}) } });

function run(observation: Observation, restartOk: boolean, json = false, extra: { stillDisconnected?: () => boolean; after?: Observation } = {}) {
  const out: string[] = [], err: string[] = [];
  let restarts = 0;
  const pids: Array<number | null> = [];
  const done = restartRuntimeAfterDisconnect({
    observe: async () => (restarts > 0 ? extra.after ?? live("standalone") : observation),
    restart: async pid => { restarts += 1; pids.push(pid); return restartOk; },
    stillDisconnected: extra.stillDisconnected ?? (() => true),
    json,
    info: line => out.push(line),
    error: line => err.push(line),
  });
  return done.then(code => ({ code, out, err, restarts, pids }));
}

describe("ocx disconnect restarts the client runtime it left behind", () => {
  test("a live client runtime is restarted and the machine reported standalone", async () => {
    const result = await run(live("client"), true);
    expect(result).toMatchObject({ code: 0, restarts: 1, err: [] });
    expect(result.out.join("\n")).toContain("now runs standalone");
  });

  test("a restart that does not complete fails and names the remaining command", async () => {
    const result = await run(live("client"), false, false, { after: live("client") });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("client runtime (pid 4321) still serves the old connection. Run on this machine: ocx restart");
  });

  test("a standalone runtime, or confirmed absence, is left alone", async () => {
    for (const observation of [live(), live("standalone"), { kind: "absent", live: null } as const]) {
      expect(await run(observation, true)).toMatchObject({ code: 0, restarts: 0, out: [], err: [] });
    }
  });

  // findLiveProxy answers null for "nothing there" and for "could not tell" alike; a disconnect that
  // cannot rule out a still-serving client runtime must not report success to a caller over SSH.
  test("an inconclusive liveness probe fails with what to check", async () => {
    const result = await run({ kind: "unknown", live: null }, true);
    expect(result).toMatchObject({ code: 1, restarts: 0 });
    expect(result.err.join("\n")).toContain("could not confirm whether the client runtime stopped");
    expect(result.err.join("\n")).toContain("ocx status");
    expect(result.err.join("\n")).toContain("ocx restart");
  });

  // Final review: a connect that lands between disconnect and its restart owns the runtime now;
  // disconnect must leave it alone and never call the machine standalone.
  test("a connection made after the disconnect leaves its runtime alone", async () => {
    const result = await run(live("client"), true, false, { stillDisconnected: () => false });
    expect(result).toMatchObject({ code: 0, restarts: 0, err: [] });
    expect(result.out.join("\n")).toContain("a new connection was made after this disconnect");
  });

  test("standalone is reported only when the runtime after the restart is not a client", async () => {
    const result = await run(live("client"), true, false, { after: live("client") });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("still answers as a client");
  });

  // Coordinator review round 2: the restart is bound to the runtime disconnect observed.
  test("the restart is bound to the observed runtime's pid", async () => {
    expect((await run(live("client"), true)).pids).toEqual([4321]);
  });

  // ...and standalone is claimed only for a live, non-client runtime after it.
  test.each([
    ["absent", { kind: "absent", live: null } as const],
    ["inconclusive", { kind: "unknown", live: null } as const],
  ])("an %s observation after the restart fails with what to run", async (_name, after) => {
    const result = await run(live("client"), true, false, { after });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("could not confirm a standalone runtime");
    expect(result.err.join("\n")).toContain("ocx status");
  });

  test("--json keeps stdout to the disconnect document", async () => {
    const logged: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try {
      let restarted = false;
      const result = await restartRuntimeAfterDisconnect({
        observe: async () => live(restarted ? "standalone" : "client"),
        restart: async () => { console.log("restart progress"); restarted = true; return true; },
        stillDisconnected: () => true,
        json: true,
        error: () => {},
      });
      expect(result).toBe(0);
    } finally { console.log = original; }
    expect(logged).toEqual([]);
  });
});

// Coordinator review round 2: a connect that commits after disconnect's check can start a new
// client runtime before the restart discovers its target. The hook at that gap is a findLive that
// answers a different pid: the request must never be sent, and nothing may be started generically.
describe("a disconnect restart bound to the observed runtime", () => {
  function io(found: { status: "live"; pid: number } | { status: "absent" }) {
    const calls: string[] = [];
    const base: ProxyRestartIo = {
      findLive: async () => found.status === "live"
        ? { status: "live", live: { pid: found.pid, port: 10100, source: "runtime" } }
        : { status: "absent" },
      startWhenStopped: async () => { calls.push("generic-start"); return { status: "started" }; },
      requestInPlaceRestart: async previous => { calls.push(`request:${previous.pid}`); return { accepted: true }; },
      waitForReplacement: async () => ({ pid: 9999, port: 10100, source: "runtime" }),
      waitBetweenAttempts: async () => {},
    };
    return { calls, base };
  }

  test("a different runtime at the restart's own discovery is refused before any request", async () => {
    const { calls, base } = io({ status: "live", pid: 5555 });
    const result = await runProxyRestart(bindRestartToPid(base, 4321));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ ok: false, phase: "request" });
    expect(String((result as { error?: unknown }).error)).toContain("restart_target_changed");
  });

  test("the observed runtime is restarted", async () => {
    const { calls, base } = io({ status: "live", pid: 4321 });
    expect((await runProxyRestart(bindRestartToPid(base, 4321))).ok).toBe(true);
    expect(calls).toEqual(["request:4321"]);
  });

  test("a runtime that vanished gets no generic start", async () => {
    const { calls, base } = io({ status: "absent" });
    await runProxyRestart(bindRestartToPid(base, 4321));
    expect(calls).toEqual([]);
  });
});
