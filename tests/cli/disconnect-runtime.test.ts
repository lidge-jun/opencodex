import { describe, expect, test } from "bun:test";
import { restartRuntimeAfterDisconnect, type DisconnectRuntimeDeps } from "../../src/cli/disconnect-runtime";

type Observation = Awaited<ReturnType<DisconnectRuntimeDeps["observe"]>>;
const live = (role?: string): Observation => ({ kind: "live", live: { pid: 4321, ...(role ? { role } : {}) } });

function run(observation: Observation, restartOk: boolean, json = false, extra: { stillDisconnected?: () => boolean; after?: Observation } = {}) {
  const out: string[] = [], err: string[] = [];
  let restarts = 0;
  const done = restartRuntimeAfterDisconnect({
    observe: async () => (restarts > 0 ? extra.after ?? live("standalone") : observation),
    restart: async () => { restarts += 1; return restartOk; },
    stillDisconnected: extra.stillDisconnected ?? (() => true),
    json,
    info: line => out.push(line),
    error: line => err.push(line),
  });
  return done.then(code => ({ code, out, err, restarts }));
}

describe("ocx disconnect restarts the client runtime it left behind", () => {
  test("a live client runtime is restarted and the machine reported standalone", async () => {
    const result = await run(live("client"), true);
    expect(result).toMatchObject({ code: 0, restarts: 1, err: [] });
    expect(result.out.join("\n")).toContain("now runs standalone");
  });

  test("a restart that does not complete fails and names the remaining command", async () => {
    const result = await run(live("client"), false);
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
