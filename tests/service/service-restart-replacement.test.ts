import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { confirmServiceServing, reportServiceServing, servingRuntimePid } from "../../src/service/health";

/**
 * #7771: `ocx service restart` printed "restarted and serving" while the runtime that answered
 * was the one the restart should have replaced (a surviving Windows wrapper kept its child). The
 * restart path now names the pid that answered before it and withholds success until another
 * runtime answers.
 */
const clock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
};

afterEach(() => {
  process.exitCode = 0;
});

describe("restart replacement confirmation", () => {
  test("the replaced runtime still answering is not a confirmed restart", async () => {
    const time = clock();
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1", replacing: 4242,
      identify: async () => ({ pid: 4242 }), timeoutMs: 2_000, ...time,
    });
    expect(out).toEqual({ ok: false, port: 10100, staleRuntimePid: 4242 });
  });

  test("a different runtime answering confirms the restart", async () => {
    const time = clock();
    let calls = 0;
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1", replacing: 4242,
      identify: async () => (++calls < 3 ? { pid: 4242 } : { pid: 5151 }), timeoutMs: 10_000, ...time,
    });
    expect(out).toEqual({ ok: true, port: 10100, runtimePid: 5151 });
    expect(calls).toBe(3);
  });

  test("an answer without a pid cannot be shown to be the old runtime", async () => {
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1", replacing: 4242,
      identify: async () => ({ pid: null }), timeoutMs: 0, ...clock(),
    });
    expect(out).toEqual({ ok: true, port: 10100 });
  });

  test("silence after the old runtime left is still reported as not serving", async () => {
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1", replacing: 4242,
      identify: async () => null, timeoutMs: 1_000, ...clock(),
    });
    expect(out).toEqual({ ok: false, port: 10100 });
  });

  test("without a replaced pid the boolean probe keeps deciding", async () => {
    let identified = false;
    const out = await confirmServiceServing({
      port: 10100, hostname: "127.0.0.1", replacing: null,
      probe: async () => true, identify: async () => { identified = true; return { pid: 1 }; }, ...clock(),
    });
    expect(out).toEqual({ ok: true, port: 10100 });
    expect(identified).toBe(false);
  });

  test("servingRuntimePid reads the answering pid and never throws", async () => {
    expect(await servingRuntimePid({ port: 10100, hostname: "127.0.0.1", identify: async () => ({ pid: 77 }) })).toBe(77);
    expect(await servingRuntimePid({ port: 10100, hostname: "127.0.0.1", identify: async () => null })).toBeNull();
    expect(await servingRuntimePid({ port: 10100, hostname: "127.0.0.1", identify: async () => { throw new Error("refused"); } })).toBeNull();
  });
});

describe("restart replacement report", () => {
  const capture = () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => { lines.push(args.join(" ")); };
    const log = spyOn(console, "log").mockImplementation(record);
    const error = spyOn(console, "error").mockImplementation(record);
    return {
      text: () => lines.join("\n"),
      restore: () => { log.mockRestore(); error.mockRestore(); },
    };
  };

  test("the old runtime still serving fails the restart without a checkmark", async () => {
    const out = capture();
    try {
      await reportServiceServing("restarted", {
        port: 10100, hostname: "127.0.0.1", replacing: 4242,
        identify: async () => ({ pid: 4242 }), timeoutMs: 1_000, ...clock(),
      });
    } finally { out.restore(); }
    expect(out.text()).toContain("previous runtime (PID 4242) is still serving on port 10100");
    expect(out.text()).toContain("replacement was not confirmed");
    expect(out.text()).not.toContain("✅");
    expect(process.exitCode).toBe(1);
  });

  test("a thrown restart with the old runtime answering says it was kept", async () => {
    const out = capture();
    try {
      await reportServiceServing("restarted", {
        port: 10100, hostname: "127.0.0.1", replacing: 4242,
        identify: async () => ({ pid: 4242 }), timeoutMs: 1_000, ...clock(),
      }, new Error("schtasks /run failed"));
    } finally { out.restore(); }
    expect(out.text()).toContain("schtasks /run failed");
    expect(out.text()).toContain("previous runtime (PID 4242) is still answering on port 10100");
    expect(out.text()).not.toContain("No proxy answered");
    expect(process.exitCode).toBe(1);
  });

  test("a thrown restart answered by the old runtime reports at once instead of polling", async () => {
    // Most restart failures refuse before stopping anything, so the old runtime answering is
    // final; waiting out the 20 s (45 s on Windows) budget only delayed the error.
    const out = capture();
    let identified = 0;
    let slept = 0;
    try {
      await reportServiceServing("restarted", {
        port: 10100, hostname: "127.0.0.1", replacing: 4242,
        identify: async () => { identified += 1; return { pid: 4242 }; },
        sleep: async ms => { slept += ms; }, now: () => 0, timeoutMs: 45_000,
      }, new Error("service is not installed"));
    } finally { out.restore(); }
    expect(identified).toBe(1);
    expect(slept).toBe(0);
    expect(out.text()).toContain("still answering on port 10100; it was kept, not replaced");
    expect(process.exitCode).toBe(1);
  });

  test("a thrown restart with a new runtime answering names the new runtime", async () => {
    const out = capture();
    try {
      await reportServiceServing("restarted", {
        port: 10100, hostname: "127.0.0.1", replacing: 4242,
        identify: async () => ({ pid: 5151 }), timeoutMs: 1_000, ...clock(),
      }, new Error("wrapper cleanup failed"));
    } finally { out.restore(); }
    expect(out.text()).toContain("A new runtime (PID 5151) is answering on port 10100");
    expect(out.text()).not.toContain("kept rather than replaced");
    expect(process.exitCode).toBe(1);
  });

  test("a replaced runtime reports success", async () => {
    const out = capture();
    try {
      await reportServiceServing("restarted", {
        port: 10100, hostname: "127.0.0.1", replacing: 4242,
        identify: async () => ({ pid: 5151 }), timeoutMs: 1_000, ...clock(),
      });
    } finally { out.restore(); }
    expect(out.text()).toContain("✅ opencodex service restarted and serving on port 10100.");
    expect(process.exitCode).toBe(0);
  });
});
