import { expect, test } from "bun:test";
import { guardedReclaimListenPort, type UpdateReclaimOptions } from "../../src/update/guarded-port-reclaim";
import type { ReclaimListenPortOptions } from "../../src/server/port-reclaim";

function fixture(gate?: unknown) {
  const effects: string[] = [];
  const options: ReclaimListenPortOptions = {
    timeoutMs: 100, intervalMs: 0, scanIntervalMs: 0,
    killOcxHolders: true, onlyKillPids: [4242], dropTcpRows: true,
    listListenPidsFn: () => [4242], isAliveFn: () => true, verifyOcxFn: pid => pid,
    killFn: () => { effects.push("kill"); }, dropTcpFn: () => { effects.push("tcp"); return 1; },
    isAvailableFn: async () => { effects.push("probe"); return true; },
    sleepMs: async () => {},
    ...(gate === "omit" ? {} : { mayMutateFn: gate as () => boolean }),
  };
  return { effects, options: options as UpdateReclaimOptions };
}

for (const gate of ["omit", undefined, null, false, 1])
  test(`update reclaim refuses a missing or invalid authorizer (${gate}) before I/O`, async () => {
    const { effects, options } = fixture(gate);
    // Exercise runtime callers that bypass the mandatory TypeScript parameter.
    expect(await guardedReclaimListenPort(19001, "127.0.0.1", options)).toBe(false);
    expect(effects).toEqual([]);
  });

for (const gate of [() => false, () => { throw new Error("fixture"); }, async () => true])
  test("update reclaim refuses denial, throwing and asynchronous authorizers", async () => {
    const { effects, options } = fixture(gate);
    expect(await guardedReclaimListenPort(19001, "127.0.0.1", options)).toBe(false);
    expect(effects).toEqual([]);
  });

test("update reclaim with a synchronous authorizer retains the available-port result", async () => {
  const { effects, options } = fixture(() => true);
  expect(await guardedReclaimListenPort(19001, "127.0.0.1", options)).toBe(true);
  expect(effects).toEqual(["probe"]);
});

test("update reclaim refuses an inherited authorizer", async () => {
  const { effects, options } = fixture("omit");
  Object.setPrototypeOf(options, { mayMutateFn: () => true });
  expect(await guardedReclaimListenPort(19001, "127.0.0.1", options)).toBe(false);
  expect(effects).toEqual([]);
});

test("update reclaim checks authority after option getters and after availability awaits", async () => {
  for (const phase of ["options", "availability"]) {
    let allowed = true;
    const { effects, options } = fixture(() => allowed);
    if (phase === "options") Object.defineProperty(options, "timeoutMs", {
      enumerable: true, get() { allowed = false; return 100; },
    });
    else options.isAvailableFn = async () => { effects.push("probe"); allowed = false; return true; };
    expect(await guardedReclaimListenPort(19001, "127.0.0.1", options)).toBe(false);
    expect(effects).toEqual(phase === "options" ? [] : ["probe"]);
  }
});
