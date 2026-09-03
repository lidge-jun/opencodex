import { describe, expect, test } from "bun:test";

import { parseStrictSemver } from "../src/lib/strict-semver";

/**
 * The prerelease section used to be matched by the semver.org pattern verbatim, whose three
 * identifier alternatives overlap. Wrapped in a repetition, that gives a backtracking engine an
 * exponential number of ways to split one string. CodeQL flagged it as `js/redos` and the cost
 * was real rather than theoretical: a 125-character input took 522ms.
 *
 * The length ceiling did not help. It only chose where on the curve the input landed.
 */
/**
 * Every timing assertion here measures the BEST of several runs, not a single one.
 *
 * A first call carries one-time cost the parse itself does not: regex compilation, JIT
 * warm-up, and whatever the shared CI runner was doing during that millisecond. On a
 * loaded macOS runner that noise reached 53.77ms against a 50ms budget and failed a
 * suite whose subject is three orders of magnitude away from the regression it guards
 * (522ms). A gate that fires on runner weather rather than on the defect teaches
 * everyone to re-run it, which is how a real ReDoS regression would get waved through.
 *
 * The minimum is the right statistic for this question. Superlinear backtracking is a
 * property of the pattern, so it reproduces on EVERY iteration; scheduler noise does
 * not. If the exponential path returns, no run is fast.
 *
 * That claim was measured rather than assumed. Running the semver.org prerelease
 * pattern this module replaced against the same inputs, three runs each:
 *
 *     reps=20  len=68    17.6ms  17.4ms  17.4ms
 *     reps=30  len=98   545.4ms 521.2ms 500.0ms
 *     reps=39  len=125  492.3ms 493.5ms 491.3ms
 *     reps=45  len=128  495.3ms 507.9ms 527.8ms
 *
 * The blowup is on every run, not the first, so a best-of-N below 50ms still fails
 * loudly if it comes back. The spread across runs is under 10%, which is what a
 * deterministic cost looks like next to the 4ms of scheduler jitter that broke the
 * single-sample form.
 */
function fastestParseMs(input: string, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    parseStrictSemver(input);
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

describe("parseStrictSemver ReDoS resistance", () => {
  test("the flagged attack shape stays linear at the length ceiling", () => {
    // "0.0.0-0." followed by repetitions of "--." is the input CodeQL named.
    const attack = ("0.0.0-0." + "--.".repeat(45)).slice(0, 128);
    expect(attack.length).toBe(128);

    expect(parseStrictSemver(attack)).toBeNull();

    // The vulnerable pattern took ~522ms for this input. Anything in that region means the
    // superlinear path is back; a linear parse lands three orders of magnitude below it.
    expect(fastestParseMs(attack)).toBeLessThan(50);
  });

  test("cost does not grow with the number of repetitions", () => {
    const inputFor = (reps: number): string => ("0.0.0-0." + "--.".repeat(reps)).slice(0, 128);

    // Under the old pattern, going from 20 to 39 repetitions moved 16ms to 524ms.
    expect(fastestParseMs(inputFor(20))).toBeLessThan(50);
    expect(fastestParseMs(inputFor(39))).toBeLessThan(50);
  });

  test("the length guard still rejects before any matching work", () => {
    const huge = "0.0.0-0." + "--.".repeat(200);
    expect(huge.length).toBeGreaterThan(128);
    expect(parseStrictSemver(huge)).toBeNull();
    expect(parseStrictSemver("1.0.0", 4)).toBeNull();
  });
});

describe("parseStrictSemver grammar", () => {
  test("accepts the semver.org examples", () => {
    for (const valid of [
      "0.0.0",
      "1.2.3",
      "10.20.30",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-0.3.7",
      "1.0.0-x.7.z.92",
      "1.0.0-alpha.beta",
      "1.0.0--",
      "1.0.0-a-b",
      "2.38.0-preview.20260831",
      "1.0.0-alpha+001",
      "1.0.0+20130313144700",
      "1.0.0-beta+exp.sha.5114f85",
      "1.0.0+21AF26D3----117B344092BD",
    ]) {
      expect(parseStrictSemver(valid)?.raw).toBe(valid);
    }
  });

  test("rejects leading zeroes, empty identifiers and non-semver shapes", () => {
    for (const invalid of [
      "01.0.0",
      "1.01.0",
      "1.0.01",
      "1.0",
      "1.0.0.0",
      "1.0.0-",
      "1.0.0-.",
      "1.0.0-01",
      "1.0.0-00",
      "1.0.0-a..b",
      "1.0.0-a.",
      "1.0.0-a.01",
      "1.0.0+",
      "v1.0.0",
      "1.0.0-alpha_beta",
      "",
    ]) {
      expect(parseStrictSemver(invalid)).toBeNull();
    }
  });

  test("splits the prerelease into numeric and alphanumeric identifiers", () => {
    const parsed = parseStrictSemver("1.0.0-0.3.7-x");
    expect(parsed?.core).toEqual([1n, 0n, 0n]);
    expect(parsed?.prerelease).toEqual([0n, 3n, "7-x"]);
  });

  test("a version with no prerelease has an empty prerelease list", () => {
    expect(parseStrictSemver("2.38.0")?.prerelease).toEqual([]);
  });
});
