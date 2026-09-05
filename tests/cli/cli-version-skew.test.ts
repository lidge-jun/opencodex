import { describe, expect, test } from "bun:test";
import { computeVersionSkew } from "../../src/cli/version-skew";
import { packageVersion } from "../../src/cli/help";

/**
 * #2701: an older `ocx` earlier on PATH than the running proxy described a different
 * build, and nothing surfaced it because the CLI never compared the two versions.
 */
describe("version skew detection", () => {
  test("reports skew when the proxy reports a different version", () => {
    const skew = computeVersionSkew("2.35.0", "2.36.1");
    expect(skew.skewed).toBe(true);
    expect(skew.cliVersion).toBe("2.35.0");
    expect(skew.proxyVersion).toBe("2.36.1");
    expect(skew.warning).toContain("2.35.0");
    expect(skew.warning).toContain("2.36.1");
    expect(skew.warning).toContain("stale");
  });

  test("stays quiet when the versions match", () => {
    const skew = computeVersionSkew("2.35.0", "2.35.0");
    expect(skew.skewed).toBe(false);
    expect(skew.warning).toBeNull();
  });

  test("stays quiet when nothing is live", () => {
    const skew = computeVersionSkew("2.35.0", undefined);
    expect(skew.skewed).toBe(false);
    expect(skew.proxyVersion).toBeNull();
    expect(skew.warning).toBeNull();
  });

  test("suppresses the warning when the proxy reports the 0.0.0 placeholder", () => {
    // The server's VERSION falls back to "0.0.0" when it cannot resolve its own package.
    // Comparing against it would send an operator to reinstall a healthy install.
    expect(computeVersionSkew("2.35.0", "0.0.0").skewed).toBe(false);
    expect(computeVersionSkew("2.35.0", "0.0.0").warning).toBeNull();
  });

  test("suppresses the warning when the CLI cannot resolve its own version", () => {
    // packageVersion() answers "unknown" for a non-string version; that means "cannot
    // compare", not "different".
    expect(computeVersionSkew("unknown", "2.36.1").skewed).toBe(false);
    expect(computeVersionSkew("unknown", "2.36.1").warning).toBeNull();
  });

  test("a legacy proxy version still compares, since it is a real version", () => {
    // A pre-identity healthz body carries a version even without a pid, and an older proxy
    // is precisely the skew worth reporting.
    expect(computeVersionSkew("2.35.0", "2.6.16").skewed).toBe(true);
  });

  test("packageVersion is exported and resolves a real version", () => {
    const version = packageVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
    expect(version).not.toBe("unknown");
  });
});
