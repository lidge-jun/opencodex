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
describe("parseStrictSemver ReDoS resistance", () => {
  test("the flagged attack shape stays linear at the length ceiling", () => {
    // "0.0.0-0." followed by repetitions of "--." is the input CodeQL named.
    const attack = ("0.0.0-0." + "--.".repeat(45)).slice(0, 128);
    expect(attack.length).toBe(128);

    const started = performance.now();
    expect(parseStrictSemver(attack)).toBeNull();
    const elapsed = performance.now() - started;

    // The vulnerable pattern took ~522ms for this input. Anything in that region means the
    // superlinear path is back; a linear parse lands three orders of magnitude below it.
    expect(elapsed).toBeLessThan(50);
  });

  test("cost does not grow with the number of repetitions", () => {
    const measure = (reps: number): number => {
      const input = ("0.0.0-0." + "--.".repeat(reps)).slice(0, 128);
      const started = performance.now();
      parseStrictSemver(input);
      return performance.now() - started;
    };

    // Under the old pattern, going from 20 to 39 repetitions moved 16ms to 524ms.
    measure(20);
    const short = measure(20);
    const long = measure(39);
    expect(short).toBeLessThan(50);
    expect(long).toBeLessThan(50);
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
