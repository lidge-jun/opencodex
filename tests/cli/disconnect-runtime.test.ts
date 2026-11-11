import { describe, expect, test } from "bun:test";
import { restartRuntimeAfterDisconnect } from "../../src/cli/disconnect-runtime";

function run(live: { pid: number | null; role?: string } | null, restartOk: boolean, json = false) {
  const out: string[] = [], err: string[] = [];
  let restarts = 0;
  const done = restartRuntimeAfterDisconnect({
    findLive: async () => live,
    restart: async () => { restarts += 1; return restartOk; },
    json,
    info: line => out.push(line),
    error: line => err.push(line),
  });
  return done.then(code => ({ code, out, err, restarts }));
}

describe("ocx disconnect restarts the client runtime it left behind", () => {
  test("a live client runtime is restarted and the machine reported standalone", async () => {
    const result = await run({ pid: 4321, role: "client" }, true);
    expect(result).toMatchObject({ code: 0, restarts: 1, err: [] });
    expect(result.out.join("\n")).toContain("now runs standalone");
  });

  test("a restart that does not complete fails and names the remaining command", async () => {
    const result = await run({ pid: 4321, role: "client" }, false);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("client runtime (pid 4321) still serves the old connection. Run on this machine: ocx restart");
  });

  test("a standalone runtime or none is left alone", async () => {
    for (const live of [{ pid: 4321 }, { pid: 4321, role: "standalone" }, null]) {
      expect(await run(live, true)).toMatchObject({ code: 0, restarts: 0, out: [], err: [] });
    }
  });

  test("--json keeps stdout to the disconnect document", async () => {
    const logged: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { logged.push(args); };
    try {
      const result = await restartRuntimeAfterDisconnect({
        findLive: async () => ({ pid: 1, role: "client" }),
        restart: async () => { console.log("restart progress"); return true; },
        json: true,
        error: () => {},
      });
      expect(result).toBe(0);
    } finally { console.log = original; }
    expect(logged).toEqual([]);
  });
});
