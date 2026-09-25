/**
 * OCX_PROBE_TIMEOUT_MS: the probe ceilings are module-load constants, so each wiring case
 * runs in a fresh child interpreter with its own environment. Nothing in this process's
 * environment or module registry changes, so no other test file can observe an override.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PROBE_TIMEOUT_MS,
  parseProbeTimeoutOverrideMs,
  probeCeilingMs,
} from "../../src/server/proxy-liveness";
import { repoPath } from "../helpers/repo-root";

type Ceilings = { defaultMs: number; stopMs: number; stopAttempts: number; startMs: number; startAttempts: number };

function ceilingsUnder(value: string | undefined): Ceilings {
  const env: Record<string, string | undefined> = { ...process.env };
  if (value === undefined) delete env.OCX_PROBE_TIMEOUT_MS;
  else env.OCX_PROBE_TIMEOUT_MS = value;
  const script = [
    `const m = await import(${JSON.stringify(repoPath("src", "server", "proxy-liveness.ts"))});`,
    "console.log(JSON.stringify({",
    "  defaultMs: m.DEFAULT_PROBE_TIMEOUT_MS,",
    "  stopMs: m.SERVICE_STOP_LIVENESS.timeoutMs, stopAttempts: m.SERVICE_STOP_LIVENESS.attempts,",
    "  startMs: m.START_OWNERSHIP_LIVENESS.timeoutMs, startAttempts: m.START_OWNERSHIP_LIVENESS.attempts,",
    "}));",
  ].join("\n");
  const child = Bun.spawnSync([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const lines = child.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as Ceilings;
}

describe("parseProbeTimeoutOverrideMs", () => {
  test("accepts positive integer milliseconds up to the ceiling", () => {
    expect(parseProbeTimeoutOverrideMs("1")).toBe(1);
    expect(parseProbeTimeoutOverrideMs("  4321 ")).toBe(4321);
    expect(parseProbeTimeoutOverrideMs(String(MAX_PROBE_TIMEOUT_MS))).toBe(30_000);
  });

  test("ignores absent, malformed, zero, and over-ceiling values", () => {
    for (const raw of [undefined, "", "   ", "abc", "1.5", "-5", "+7", "0", "30001", "2147483648", "99999999999999999999"]) {
      expect(parseProbeTimeoutOverrideMs(raw)).toBeUndefined();
    }
  });
});

describe("probeCeilingMs keeps each shipped floor", () => {
  test("an override can raise a ceiling but never lower it", () => {
    expect(probeCeilingMs(750, undefined)).toBe(750);
    expect(probeCeilingMs(750, 1)).toBe(750);
    expect(probeCeilingMs(750, 749)).toBe(750);
    expect(probeCeilingMs(750, 1000)).toBe(1000);
    expect(probeCeilingMs(1500, 1000)).toBe(1500);
    expect(probeCeilingMs(1500, 30_000)).toBe(30_000);
  });
});

describe("OCX_PROBE_TIMEOUT_MS wiring at module load", () => {
  test("unset keeps the shipped ceilings", () => {
    expect(ceilingsUnder(undefined)).toEqual({ defaultMs: 750, stopMs: 1500, stopAttempts: 3, startMs: 1500, startAttempts: 3 });
  });

  test("values below a floor never shorten it", () => {
    for (const value of ["1", "749", "750"]) {
      const c = ceilingsUnder(value);
      expect(c.defaultMs).toBe(750);
      expect(c.stopMs).toBe(1500);
      expect(c.startMs).toBe(1500);
    }
  });

  test("a value between the floors raises only the shared default", () => {
    expect(ceilingsUnder("1000")).toEqual({ defaultMs: 1000, stopMs: 1500, stopAttempts: 3, startMs: 1500, startAttempts: 3 });
  });

  test("the ceiling raises every budget and keeps the stop wait bounded", () => {
    const c = ceilingsUnder("30000");
    expect(c).toEqual({ defaultMs: 30_000, stopMs: 30_000, stopAttempts: 3, startMs: 30_000, startAttempts: 3 });
    // The single-shot stop deadline in src/service/orchestration.ts is timeoutMs * attempts + 250.
    expect(c.stopMs * c.stopAttempts + 250).toBeLessThanOrEqual(90_250);
  });

  test("over-ceiling and malformed values fall back to the shipped ceilings", () => {
    for (const value of ["30001", "2147483647", "not-a-number", "0"]) {
      expect(ceilingsUnder(value)).toEqual({ defaultMs: 750, stopMs: 1500, stopAttempts: 3, startMs: 1500, startAttempts: 3 });
    }
  });
});
