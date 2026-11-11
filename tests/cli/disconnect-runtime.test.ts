import { describe, expect, test } from "bun:test";
import { attestRuntimeGeneration, bindRestartToRuntime, restartRuntimeAfterDisconnect, stopCapturedRuntime, type DisconnectRuntimeDeps, type RuntimeGeneration } from "../../src/cli/disconnect-runtime";
import { OWNER_UNPROVEN_RECOVERY } from "../../src/cli/restart-failure";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { runProxyRestart, type ProxyRestartIo } from "../../src/cli/tray-proxy";
import { createLocalAttestationProof, createLocalAttestationSecret, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";

type Observation = Awaited<ReturnType<DisconnectRuntimeDeps["observe"]>>;
type State = ReturnType<DisconnectRuntimeDeps["connectionState"]>;
const live = (role?: string, pid = 4321): Observation => ({ kind: "live", live: { pid, port: 10100, ...(role ? { role } : {}) } });
const generation: RuntimeGeneration = { pid: 4321, port: 10100, hostname: "127.0.0.1", attestationSecret: createLocalAttestationSecret() };

function run(observation: Observation, restartOk: boolean, json = false, extra: { state?: State; states?: State[]; after?: Observation; capture?: RuntimeGeneration | null; captureAfter?: RuntimeGeneration | null; refusedBy?: "service-unproven" | "owner-unproven"; observations?: Observation[]; stopped?: "exited" | "changed" | "kept" } = {}) {
  const out: string[] = [], err: string[] = [];
  let restarts = 0;
  const bound: RuntimeGeneration[] = [];
  const events: string[] = [];
  const done = restartRuntimeAfterDisconnect({
    observe: async () => {
      const seen = extra.observations ? extra.observations.shift()! : restarts > 0 ? extra.after ?? live("standalone", 9999) : observation;
      events.push(`observe:${seen.kind}${seen.live?.role ? `:${seen.live.role}` : ""}`);
      return seen;
    },
    capture: () => (restarts > 0 && extra.captureAfter !== undefined ? extra.captureAfter : extra.capture === undefined ? generation : extra.capture),
    connectionState: () => extra.states?.shift() ?? extra.state ?? { kind: "disconnected" },
    restart: async target => { restarts += 1; bound.push(target); events.push("restart"); return { ok: restartOk, ...(extra.refusedBy ? { refusedBy: extra.refusedBy } : {}) }; },
    stopCaptured: async target => { events.push(`stop:${target.pid}`); return extra.stopped ?? "kept"; },
    start: async () => { events.push("start"); },
    json,
    info: line => out.push(line),
    error: line => err.push(line),
  });
  return done.then(code => ({ code, out, err, restarts, bound, events }));
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

  test("an inconclusive liveness probe fails with what to check", async () => {
    const result = await run({ kind: "unknown", live: null }, true);
    expect(result).toMatchObject({ code: 1, restarts: 0 });
    expect(result.err.join("\n")).toContain("could not confirm whether the client runtime stopped");
  });

  test("the restart is bound to the generation captured from the observed runtime", async () => {
    expect((await run(live("client"), true)).bound).toEqual([generation]);
  });

  test("a client runtime whose generation cannot be captured is not restarted", async () => {
    const result = await run(live("client"), true, false, { capture: null });
    expect(result).toMatchObject({ code: 1, restarts: 0 });
    expect(result.err.join("\n")).toContain("could not identify the running client runtime");
  });

  // Coordinator review round 3: any state but disconnected stops the leave before the Home's own
  // \`ocx restart\`, which would interrupt a connection that just landed or act on unreadable state.
  test.each([
    ["connected", { kind: "connected" } as State, "A new connection is in use on this machine"],
    ["invalid", { kind: "invalid", reason: "config.json is missing or unreadable" } as State, "client state is invalid (config.json is missing or unreadable)"],
    ["mismatched", { kind: "mismatched", reason: "runtimeRole=client is present without config.json.client" } as State, "client state is mismatched (runtimeRole=client is present without config.json.client)"],
  ])("a %s state after disconnect exits 1 and restarts nothing", async (_name, state, message) => {
    const result = await run(live("client"), true, false, { state });
    expect(result).toMatchObject({ code: 1, restarts: 0, out: [] });
    expect(result.err.join("\n")).toContain(message);
  });

  // The rule holds on every branch: exit 0 needs a disconnected state, read again before exit 0.
  test.each([
    ["no runtime", { kind: "absent", live: null } as Observation],
    ["a standalone runtime", live("standalone")],
  ])("%s with a connected state exits 1", async (_name, observation) => {
    const result = await run(observation, true, false, { state: { kind: "connected" } });
    expect(result).toMatchObject({ code: 1, restarts: 0, out: [] });
    expect(result.err.join("\n")).toContain("A new connection is in use on this machine");
  });

  test("a connection that lands during the restart turns the standalone result into exit 1", async () => {
    const result = await run(live("client"), true, false, { states: [{ kind: "disconnected" }, { kind: "connected" }] });
    expect(result).toMatchObject({ code: 1, restarts: 1, out: [] });
    expect(result.err.join("\n")).toContain("A new connection is in use on this machine");
  });

  // Coordinator review round 4: when a client still answers after a refused or failed restart,
  // say what is true; recommend a plain ocx restart only when the captured runtime still answers.
  const newer: RuntimeGeneration = { pid: 5555, port: 10100, attestationSecret: createLocalAttestationSecret() };
  test("a new connection in use after a refused restart is reported, with no restart advice", async () => {
    const result = await run(live("client"), false, false, { after: live("client", 5555), captureAfter: newer, states: [{ kind: "disconnected" }, { kind: "connected" }] });
    expect(result.code).toBe(1);
    const text = result.err.join("\n");
    expect(text).toContain("A new connection is in use on this machine");
    expect(text).toContain("ocx status");
    expect(text).not.toContain("Run on this machine: ocx restart");
  });

  test("a different client runtime with the state still disconnected is reported for inspection", async () => {
    const result = await run(live("client"), false, false, { after: live("client", 5555), captureAfter: newer });
    expect(result.code).toBe(1);
    const text = result.err.join("\n");
    expect(text).toContain("A different client runtime (pid 5555) answers now");
    expect(text).not.toContain("Run on this machine: ocx restart");
  });

  test("an unreadable state after a refused restart says what to check", async () => {
    const result = await run(live("client"), false, false, { after: live("client", 5555), captureAfter: newer, states: [{ kind: "disconnected" }, { kind: "invalid", reason: "config.json is missing or unreadable" }] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("client state is invalid (config.json is missing or unreadable)");
    expect(result.err.join("\n")).not.toContain("Run on this machine: ocx restart");
  });

  test("nothing answering after the restart while a new connection exists reports that connection", async () => {
    const result = await run(live("client"), true, false, { after: { kind: "absent", live: null }, states: [{ kind: "disconnected" }, { kind: "connected" }] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("A new connection is in use on this machine");
    expect(result.err.join("\n")).not.toMatch(/ocx restart/);
  });

  test.each([
    ["absent", { kind: "absent", live: null } as const],
    ["inconclusive", { kind: "unknown", live: null } as const],
  ])("an %s observation after the restart fails with what to run", async (_name, after) => {
    const result = await run(live("client"), true, false, { after });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("could not confirm a standalone runtime");
  });

  // Coordinator review round 5: the early exits (inconclusive liveness, uncapturable record) read the
  // state too, and a connection that landed gets inspection advice, never a restart.
  test.each([
    ["inconclusive liveness", { kind: "unknown", live: null } as Observation, undefined],
    ["an uncapturable client runtime", live("client"), null],
  ] as const)("%s with a connection that landed advises inspection, not a restart", async (_name, observation, capture) => {
    const result = await run(observation, true, false, { state: { kind: "connected" }, ...(capture === null ? { capture: null } : {}) });
    expect(result).toMatchObject({ code: 1, restarts: 0 });
    const text = result.err.join("\n");
    expect(text).toContain("A new connection is in use on this machine");
    expect(text).toContain("ocx status");
    expect(text).not.toMatch(/ocx restart/);
  });

  // One rule for every exit-1 branch: a plain restart is advised only while the state is
  // disconnected and the captured runtime still answers (or nothing answers at all).
  test("no exit-1 branch advises a restart while a connection is in use or the state is unreadable", async () => {
    const states: State[] = [{ kind: "connected" }, { kind: "invalid", reason: "unreadable" }, { kind: "mismatched", reason: "mixed" }];
    const newer: RuntimeGeneration = { pid: 5555, port: 10100, attestationSecret: createLocalAttestationSecret() };
    const branches: Array<Parameters<typeof run>> = [];
    for (const state of states) {
      branches.push([{ kind: "unknown", live: null }, true, false, { state }]);
      branches.push([live("client"), true, false, { state, capture: null }]);
      branches.push([live("client"), true, false, { state }]);
      branches.push([{ kind: "absent", live: null }, true, false, { state }]);
      branches.push([live("standalone"), true, false, { state }]);
      for (const after of [live("client"), live("client", 5555), { kind: "absent", live: null } as Observation, { kind: "unknown", live: null } as Observation, live("standalone", 9999)]) {
        for (const ok of [true, false]) branches.push([live("client"), ok, false, { states: [{ kind: "disconnected" }, state], after, captureAfter: newer }]);
      }
    }
    for (const args of branches) {
      const result = await run(...args);
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).not.toMatch(/ocx restart/);
    }
  });

  // Final review: a restart its service manager refused (relaunch unproven) is redone through that
  // manager; a plain ocx restart would only be refused again.
  test("a restart refused by an unproven service manager advises the manager", async () => {
    const result = await run(live("client"), false, false, { after: live("client"), refusedBy: "service-unproven" });
    expect(result.code).toBe(1);
    const text = result.err.join("\n");
    expect(text).toContain("ocx service restart");
    expect(text).not.toContain("Run on this machine: ocx restart");
  });

  // Final review round 3: a runtime whose owner cannot be proven is stopped by its captured
  // generation; OpenCodex is started only after that exit was observed.
  test("an owner-unproven runtime is stopped, its exit observed, and only then OpenCodex started", async () => {
    const result = await run(live("client"), false, false, { refusedBy: "owner-unproven", stopped: "exited", observations: [live("client"), { kind: "absent", live: null }, live("standalone", 9999)] });
    expect(result.events).toEqual(["observe:live:client", "restart", "stop:4321", "observe:absent", "start", "observe:live:standalone"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("now runs standalone");
  });

  test("a manager that relaunched the stopped runtime as standalone needs no start", async () => {
    const result = await run(live("client"), false, false, { refusedBy: "owner-unproven", stopped: "exited", observations: [live("client"), live("standalone", 9999), live("standalone", 9999)] });
    expect(result.events).not.toContain("start");
    expect(result.code).toBe(0);
  });

  test("an owner-unproven runtime that did not exit is kept, and the advice is ocx stop", async () => {
    const result = await run(live("client"), false, false, { after: live("client"), refusedBy: "owner-unproven", stopped: "kept" });
    expect(result.code).toBe(1);
    expect(result.events).not.toContain("start");
    const text = result.err.join("\n");
    expect(text).toContain(OWNER_UNPROVEN_RECOVERY);
    expect(OWNER_UNPROVEN_RECOVERY).toContain("ocx stop");
    expect(text).not.toContain("session");
    expect(text).not.toContain("Run on this machine: ocx restart");
  });

  test("another process answering for the captured runtime is not stopped and nothing is started", async () => {
    const other = { ...generation, attestationSecret: createLocalAttestationSecret() };
    const result = await run(live("client"), false, false, { after: live("client"), captureAfter: other, refusedBy: "owner-unproven", stopped: "changed" });
    expect(result.code).toBe(1);
    expect(result.events).not.toContain("start");
    expect(result.err.join("\n")).toContain("A different client runtime");
  });

  test("a connection that lands while the runtime stops gets no start", async () => {
    const result = await run(live("client"), false, false, { refusedBy: "owner-unproven", stopped: "exited", states: [{ kind: "disconnected" }, { kind: "connected" }, { kind: "connected" }], observations: [live("client"), { kind: "absent", live: null }] });
    expect(result.code).toBe(1);
    expect(result.events).not.toContain("start");
    expect(result.err.join("\n")).toContain("A new connection is in use");
  });

  // P3: after a completed restart, an unreadable state must not also claim nothing was restarted.
  test("a completed restart followed by an unreadable state does not say nothing was restarted", async () => {
    const result = await run(live("client"), true, false, { states: [{ kind: "disconnected" }, { kind: "invalid", reason: "unreadable" }] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("The client runtime was restarted");
    expect(result.err.join("\n")).not.toContain("nothing was restarted");
  });

  test("--json keeps stdout to the disconnect document", async () => {
    const logged: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try {
      let restarted = false;
      const result = await restartRuntimeAfterDisconnect({
        observe: async () => live(restarted ? "standalone" : "client", restarted ? 9999 : 4321),
        capture: () => generation,
        connectionState: () => ({ kind: "disconnected" }),
        restart: async () => { console.log("restart progress"); restarted = true; return { ok: true }; },
        json: true,
        error: () => {},
      });
      expect(result).toBe(0);
    } finally { console.log = original; }
    expect(logged).toEqual([]);
  });
});

// Coordinator review rounds 2-3: the restart must reach only the runtime generation disconnect
// observed. A pid can be reused, so the binding is the captured runtime record (pid, port and the
// per-process attestation secret), and admission is driven through the real requestBoundSystemRestart.
describe("a disconnect restart bound to the captured runtime generation", () => {
  function world(current: { pid: number; secret: string } | null) {
    const posts: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith(SYSTEM_RESTART_PATH)) { posts.push(url); return Response.json({ success: true }, { status: 202 }); }
      if (!current) throw new Error("connection refused");
      const challenge = new Headers(init.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER) ?? "";
      const proof = createLocalAttestationProof(current.secret, challenge, current.pid, 10100) ?? "";
      return Response.json({ service: "opencodex", pid: current.pid, port: 10100, role: "client", restartCapability: "v1" }, { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } });
    }) as typeof fetch;
    const calls: string[] = [];
    const io: ProxyRestartIo = {
      findLive: async () => current
        ? { status: "live", live: { pid: current.pid, port: 10100, hostname: "127.0.0.1", source: "runtime" } }
        : { status: "absent" },
      startWhenStopped: async () => { calls.push("generic-start"); return { status: "started" }; },
      requestInPlaceRestart: async () => { calls.push("unbound-request"); return { accepted: true }; },
      waitForReplacement: async () => ({ pid: 9999, port: 10100, source: "runtime" }),
      waitBetweenAttempts: async () => {},
    };
    const request = (previous: Parameters<ProxyRestartIo["requestInPlaceRestart"]>[0], readRuntime: (pid: number) => RuntimeGeneration | null) =>
      requestBoundSystemRestart({ ...previous, version: "0.0.0" } as never, Date.now() + 600_000, { fetchImpl, readRuntime: readRuntime as never, readUpdateHome: () => null, cliVersion: "0.0.0",
        findLive: (async () => current ? { pid: current.pid, port: 10100, hostname: "127.0.0.1", source: "runtime" } : null) as never });
    return { posts, calls, io, request };
  }

  test("same pid, different generation: refused before any restart request", async () => {
    const w = world({ pid: 4321, secret: createLocalAttestationSecret() });
    const result = await runProxyRestart(bindRestartToRuntime(w.io, generation, w.request));
    expect(w.posts).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(result.ok).toBe(false);
  });

  test("a different pid at the restart's own discovery is refused", async () => {
    const w = world({ pid: 5555, secret: generation.attestationSecret });
    const result = await runProxyRestart(bindRestartToRuntime(w.io, generation, w.request));
    expect(w.posts).toEqual([]);
    expect(result).toMatchObject({ ok: false, phase: "request" });
  });

  test("the captured generation is restarted", async () => {
    const w = world({ pid: 4321, secret: generation.attestationSecret });
    const result = await runProxyRestart(bindRestartToRuntime(w.io, generation, w.request));
    expect(w.posts.length, JSON.stringify(result, (_k, v) => v instanceof Error ? v.message : v)).toBe(1);
    expect(w.calls).toEqual([]);
  });

  test("a runtime that vanished gets no generic start", async () => {
    const w = world(null);
    await runProxyRestart(bindRestartToRuntime(w.io, generation, w.request));
    expect(w.calls).toEqual([]);
    expect(w.posts).toEqual([]);
  });
});

describe("stopping exactly the captured runtime", () => {
  const io = (attested: boolean, exits: boolean, throws = false) => {
    const calls: string[] = [];
    return {
      calls,
      value: {
        attest: async (target: RuntimeGeneration) => { calls.push(`attest:${target.attestationSecret === generation.attestationSecret}`); return attested; },
        terminate: (pid: number, stillTarget: () => boolean) => { calls.push(`terminate:${pid}:${stillTarget()}`); if (throws) throw new Error("refused"); },
        alive: (pid: number) => { calls.push(`alive:${pid}`); return !exits; },
        stillTarget: () => true,
      },
    };
  };
  test("an attested runtime is terminated and reported exited only once its exit is observed", async () => {
    const ok = io(true, true);
    expect(await stopCapturedRuntime(generation, ok.value)).toBe("exited");
    expect(ok.calls).toEqual(["attest:true", "terminate:4321:true", "alive:4321"]);
    const stuck = io(true, false);
    expect(await stopCapturedRuntime(generation, stuck.value)).toBe("kept");
  });
  test("a runtime that cannot prove the captured secret is never terminated", async () => {
    const other = io(false, true);
    expect(await stopCapturedRuntime(generation, other.value)).toBe("changed");
    expect(other.calls).toEqual(["attest:true"]);
  });
  test("a refused termination of a live process is kept", async () => {
    const refused = io(true, false, true);
    expect(await stopCapturedRuntime(generation, refused.value)).toBe("kept");
  });

  test("attestation needs the captured secret, pid and port, answered by the listener", async () => {
    const secret = createLocalAttestationSecret();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new Response("{}", {
      headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, request.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER) ?? "", 4321, server.port!) ?? "" },
    }) });
    try {
      const target = { pid: 4321, port: server.port!, hostname: "127.0.0.1", attestationSecret: secret };
      expect(await attestRuntimeGeneration(target)).toBe(true);
      expect(await attestRuntimeGeneration({ ...target, attestationSecret: createLocalAttestationSecret() })).toBe(false);
      expect(await attestRuntimeGeneration({ ...target, pid: 4322 })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
