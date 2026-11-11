import { describe, expect, test } from "bun:test";
import { bindRestartToRuntime, restartRuntimeAfterDisconnect, type DisconnectRuntimeDeps, type RuntimeGeneration } from "../../src/cli/disconnect-runtime";
import { claudeProxyStartEnv } from "../../src/cli/claude";
import { codexProxyStartEnv } from "../../src/cli/codex-launcher";
import { opencodeProxyStartEnv } from "../../src/cli/opencode";
import { restartOwnerEvidence } from "../../src/client/runtime-restart";
import { clientRuntimeRecord } from "../../src/client/runtime";
import { runtimeOwnerScope } from "../../src/config/process-state";
import { observeProxyLiveness } from "../../src/server/proxy-liveness";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { runProxyRestart, type ProxyRestartIo } from "../../src/cli/tray-proxy";
import { createLocalAttestationProof, createLocalAttestationSecret, LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";

type Observation = Awaited<ReturnType<DisconnectRuntimeDeps["observe"]>>;
type State = ReturnType<DisconnectRuntimeDeps["connectionState"]>;
const live = (role?: string, pid = 4321): Observation => ({ kind: "live", live: { pid, port: 10100, ...(role ? { role } : {}) } });
// A record written by a runtime with this change and a proven owner (here: no supervisor).
const generation: RuntimeGeneration = { pid: 4321, port: 10100, hostname: "127.0.0.1", attestationSecret: createLocalAttestationSecret(), restartOwner: "none" };

function run(observation: Observation, restartOk: boolean, json = false, extra: { state?: State; states?: State[]; after?: Observation; capture?: RuntimeGeneration | null; captureAfter?: RuntimeGeneration | null; refusedBy?: "service-unproven" } = {}) {
  const out: string[] = [], err: string[] = [];
  let restarts = 0;
  const bound: RuntimeGeneration[] = [];
  const done = restartRuntimeAfterDisconnect({
    observe: async () => (restarts > 0 ? extra.after ?? live("standalone", 9999) : observation),
    capture: () => (restarts > 0 && extra.captureAfter !== undefined ? extra.captureAfter : extra.capture === undefined ? generation : extra.capture),
    connectionState: () => extra.states?.shift() ?? extra.state ?? { kind: "disconnected" },
    restart: async target => { restarts += 1; bound.push(target); return { ok: restartOk, ...(extra.refusedBy ? { refusedBy: extra.refusedBy } : {}) }; },
    json,
    info: line => out.push(line),
    error: line => err.push(line),
  });
  return done.then(code => ({ code, out, err, restarts, bound }));
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

  // Final review rounds 4 and 5: origin/dev's `ocx disconnect` restarted nothing (b1148220574917c8
  // src/cli/dispatch.ts disconnect: handleDisconnectCommand's code only). The restart step acts only
  // on a record that states a proven owner (restartOwner, written by a runtime with this change).
  // A bare OCX_SERVICE=1 runtime states none; built here by the production record builder and
  // ownership check, it gets the disconnect's own 0 with nothing restarted or read further.
  test.each([
    ["a legacy service child", () => ({ OCX_SERVICE: "1", PATH: "/usr/bin" }) as NodeJS.ProcessEnv],
    ["ocx claude's proxy", () => claudeProxyStartEnv({ PATH: "/usr/bin" })],
    ["ocx codex's proxy", () => codexProxyStartEnv({ PATH: "/usr/bin" }) as NodeJS.ProcessEnv],
    ["ocx opencode's proxy", () => opencodeProxyStartEnv({ PATH: "/usr/bin" })],
  ] as const)("%s is left as origin/dev's disconnect left it: exit 0, nothing restarted", async (_name, env) => {
    const record = clientRuntimeRecord(4321, 10100, generation.attestationSecret, restartOwnerEvidence({ desktop: false, env: env() }));
    expect(record.restartOwner).toBeUndefined();
    for (const state of [{ kind: "disconnected" }, { kind: "connected" }, { kind: "invalid", reason: "x" }] as State[]) {
      const result = await run(live("client"), true, false, { capture: { ...record, attestationSecret: generation.attestationSecret }, state });
      expect(result).toMatchObject({ code: 0, restarts: 0, out: [], err: [] });
    }
  });

  // A runtime started before this change writes no restartOwner. Whatever its old handler would
  // answer (refused because the versions are known to differ, or accepted by an old handler that
  // would start its own replacement), no restart request is sent: origin/dev's disconnect, exit 0.
  test.each([
    ["versions known to differ (the request would be refused)", false],
    ["an old handler that would accept the request", true],
  ] as const)("a record without restartOwner, %s, gets origin/dev's disconnect", async (_name, wouldAccept) => {
    const { restartOwner: _dropped, ...oldRecord } = generation;
    for (const capture of [oldRecord, { ...oldRecord, restartOwner: "some-later-owner" }]) {
      for (const state of [{ kind: "disconnected" }, { kind: "connected" }] as State[]) {
        const result = await run(live("client"), wouldAccept, false, { capture, state });
        expect(result).toMatchObject({ code: 0, restarts: 0, out: [], err: [] });
      }
    }
  });

  test("a record that states a proven owner is restarted, bound to that record", async () => {
    for (const [env, desktop, owner] of [
      [{}, false, "none"],
      [{ OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" }, false, "service-manager"],
      [{ OCX_SERVICE: "1" }, true, "desktop"],
    ] as const) {
      const record = clientRuntimeRecord(4321, 10100, generation.attestationSecret, restartOwnerEvidence({ desktop, env }));
      expect(record.restartOwner).toBe(owner);
      const capture = { ...record, attestationSecret: generation.attestationSecret };
      const result = await run(live("client"), true, false, { capture });
      expect(result).toMatchObject({ code: 0, restarts: 1 });
      expect(result.bound).toEqual([capture]);
    }
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

// The merge with dev #8562 (#8552): observeProxyLiveness skips a runtime record that names this
// process's own PID from an earlier lifetime. Such a stale record can still carry a restartOwner.
// The disconnect step decides from the liveness observation first, so a stale record never reaches
// the capture or a restart. Everything is injected: no network, no real port, no real home.
describe("a stale runtime record from an earlier lifetime of this PID never drives the disconnect restart", () => {
  for (const published of [false, true]) {
    test("this process " + (published ? "has" : "has not") + " published its own records", async () => {
      const ownScope = runtimeOwnerScope();
      const stale = { pid: process.pid, port: 54321, hostname: "127.0.0.1", attestationSecret: createLocalAttestationSecret(), restartOwner: "service-manager", ownerScope: ownScope };
      const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      const observe = () => observeProxyLiveness({
        attempts: 1,
        fetchFn: (async () => { throw refused; }) as unknown as typeof fetch,
        readPidFn: () => null,
        readRuntimeFn: () => stale,
        configFn: () => ({ port: 54321, hostname: "127.0.0.1" }),
        bindProofFn: async () => true,
        readCommandLineFn: () => "bun ocx start",
        ownProcessFn: () => ({ pid: process.pid, publishedOwnership: published, scope: ownScope }),
        sleepFn: async () => {},
      });
      const seen = await observe();
      expect(seen.kind).toBe(published ? "unknown" : "absent");
      let captures = 0, restarts = 0;
      const code = await restartRuntimeAfterDisconnect({
        observe,
        capture: () => { captures += 1; return stale; },
        connectionState: () => ({ kind: "disconnected" }),
        restart: async () => { restarts += 1; return { ok: true }; },
        json: false, info: () => {}, error: () => {},
      });
      expect({ captures, restarts }).toEqual({ captures: 0, restarts: 0 });
      // An earlier lifetime proven stale reads as nothing running (origin/dev's exit 0); one this
      // process cannot rule out stays inconclusive and fails closed (exit 1), still without a request.
      expect(code).toBe(published ? 1 : 0);
    });
  }
});

