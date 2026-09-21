/**
 * OCX_PROBE_TIMEOUT_MS wiring test. The probe ceilings are module-load constants,
 * so their value depends on the environment at the moment proxy-liveness is first
 * evaluated. Bun's test files can share one module registry, which makes in-process
 * env mutation order-dependent — instead of spawning a child interpreter, each case
 * imports the module through a distinct query string: a different specifier is a
 * different module instance per ESM resolution rules, so the module body (and the
 * env read at its top level) re-runs under the environment this test just set.
 * The variable is saved and restored around every case so no other test in a shared
 * registry can observe a leftover value at its own first module load.
 */
import { afterEach, describe, expect, test } from "bun:test";

const previousOverride = process.env.OCX_PROBE_TIMEOUT_MS;

afterEach(() => {
  if (previousOverride === undefined) delete process.env.OCX_PROBE_TIMEOUT_MS;
  else process.env.OCX_PROBE_TIMEOUT_MS = previousOverride;
});

describe("OCX_PROBE_TIMEOUT_MS override wiring", () => {
  test("defaults load when the variable is unset", async () => {
    delete process.env.OCX_PROBE_TIMEOUT_MS;
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=defaults");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(750);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });

  test("an override above both defaults raises every ceiling", async () => {
    process.env.OCX_PROBE_TIMEOUT_MS = "3210";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=raise-all");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(3210);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(3210);
    expect(mod.SERVICE_STOP_LIVENESS.attempts).toBe(3);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(3210);
    expect(mod.START_OWNERSHIP_LIVENESS.attempts).toBe(3);
  });

  test("an override between the two defaults raises only the shared default", async () => {
    // 1000 lengthens the 750ms default but must NOT shorten the 1500ms stop/start
    // budgets — those exist to catch a just-bound or shadowed proxy (#764, #5004).
    process.env.OCX_PROBE_TIMEOUT_MS = "1000";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=raise-default-only");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(1000);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });

  test("a malformed override falls back to the defaults at module load", async () => {
    process.env.OCX_PROBE_TIMEOUT_MS = "not-a-number";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=malformed");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(750);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });

  test("a value beyond the signed-32-bit ceiling is ignored", async () => {
    // AbortSignal.timeout() only accepts that range; an out-of-range delay throws
    // in Bun and the probe path would misread it as a dead proxy.
    process.env.OCX_PROBE_TIMEOUT_MS = "2147483648";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=overflow");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(750);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(1500);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(1500);
  });

  test("the ceiling itself is accepted", async () => {
    process.env.OCX_PROBE_TIMEOUT_MS = "2147483647";
    const mod = await import("../../src/server/proxy-liveness.ts?wiring=ceiling");
    expect(mod.DEFAULT_PROBE_TIMEOUT_MS).toBe(2_147_483_647);
    expect(mod.SERVICE_STOP_LIVENESS.timeoutMs).toBe(2_147_483_647);
    expect(mod.START_OWNERSHIP_LIVENESS.timeoutMs).toBe(2_147_483_647);
  });
});
