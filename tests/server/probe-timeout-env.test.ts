/**
 * OCX_PROBE_TIMEOUT_MS wiring test. The probe ceilings are module-load constants,
 * so their value depends on the environment at the moment proxy-liveness is first
 * evaluated. Bun's test files can share one module registry, which makes in-process
 * env mutation order-dependent — instead of spawning a child interpreter, each case
 * imports the module through a distinct query string: a different specifier is a
 * different module instance per ESM resolution rules, so the module body (and the
 * env read at its top level) re-runs under the environment this test just set.
 */
import { describe, expect, test } from "bun:test";

describe("OCX_PROBE_TIMEOUT_MS override wiring", () => {
  test("defaults load when the variable is unset", async () => {
    delete process.env.OCX_PROBE_TIMEOUT_MS;
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=defaults");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(750);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });

  test("override raises every probe ceiling at module load", async () => {
    process.env.OCX_PROBE_TIMEOUT_MS = "3210";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=override");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(3210);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(3210);
    expect(mod.SERVICE_STOP_LIVENESS.attempts).toBe(3);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(3210);
    expect(mod.START_OWNERSHIP_LIVENESS.attempts).toBe(3);
  });

  test("a malformed override falls back to the defaults at module load", async () => {
    process.env.OCX_PROBE_TIMEOUT_MS = "not-a-number";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=malformed");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(750);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });
});
