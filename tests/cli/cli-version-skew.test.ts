import { describe, expect, test } from "bun:test";
import { computeVersionSkew, isConfirmedVersionMatch } from "../../src/cli/version-skew";
import { packageVersion } from "../../src/cli/help";

/**
 * #2701: an older `ocx` earlier on PATH than the running proxy described a different
 * build, and nothing surfaced it because the CLI never compared the two versions.
 */
describe("version skew detection", () => {
  test("directs an older CLI to upgrade or resolve PATH", () => {
    const skew = computeVersionSkew("2.35.0", "2.36.1");
    expect(skew.skewed).toBe(true);
    expect(skew.cliVersion).toBe("2.35.0");
    expect(skew.proxyVersion).toBe("2.36.1");
    expect(skew.warning).toContain("2.35.0");
    expect(skew.warning).toContain("2.36.1");
    expect(skew.warning).toContain("this ocx on PATH is older");
    expect(skew.warning).toContain("Upgrade the CLI or resolve PATH");
    expect(skew.warning).not.toContain("ocx service repair");
  });

  test("#3464 directs a newer CLI to restart the older proxy", () => {
    const skew = computeVersionSkew("2.42.0", "2.10.1-preview.20260805");
    expect(skew).toEqual({
      cliVersion: "2.42.0",
      proxyVersion: "2.10.1-preview.20260805",
      skewed: true,
      warning: "CLI 2.42.0 does not match the running proxy 2.10.1-preview.20260805 — "
        + "the running proxy is older than this CLI. Restart the proxy using the intended current installation. "
        + "For a background service, run ocx service restart (repair reloads only a changed definition).",
    });
    expect(skew.warning).not.toContain("this ocx on PATH is older");
  });

  test.each([
    ["2.43.0", "2.43.0-preview.1"],
    ["2.43.0-preview.10", "2.43.0-preview.2"],
    ["2.43.0-preview.beta", "2.43.0-preview.10"],
    ["2.43.0-preview.1", "2.43.0-preview"],
    ["2.43.0-beta", "2.43.0-alpha"],
    ["2.44.0-preview.1", "2.43.0"],
    ["10.0.0", "9.99.99"],
    ["2.43.1", "2.43.0"],
    ["2.43.0-preview.9007199254740993", "2.43.0-preview.9007199254740992"],
  ])("orders %s above %s in both directions", (newer, older) => {
    expect(computeVersionSkew(newer, older).warning).toContain("the running proxy is older");
    expect(computeVersionSkew(older, newer).warning).toContain("this ocx on PATH is older");
  });

  test.each([
    ["2.43.0+build.1", "2.43.0+build.2"],
    ["2.43.0", "2.43.0+build.1"],
    ["2.43.0-preview.1+a", "2.43.0-preview.1+b"],
    ["invalid", "2.43.0"],
    ["2.43", "2.43.0"],
    ["v2.43.0", "2.43.0"],
    [" 2.43.0", "2.43.0"],
    ["2.43.0 ", "2.43.0"],
    ["2.43.0-preview.01", "2.43.0-preview.1"],
    ["", "2.43.0"],
  ])("keeps raw unequal %s / %s neutral in both directions", (left, right) => {
    for (const [cli, proxy] of [[left, right], [right, left]]) {
      const skew = computeVersionSkew(cli!, proxy!);
      expect(skew.cliVersion).toBe(cli);
      expect(skew.proxyVersion).toBe(proxy);
      expect(skew.skewed).toBe(true);
      expect(skew.warning).toContain("neither can be identified as older");
      expect(skew.warning).not.toContain("ocx service repair");
      expect(isConfirmedVersionMatch(skew)).toBe(false);
    }
  });

  test.each(["unknown", "0.0.0"])("suppresses %s on either side without confirming a match", placeholder => {
    for (const [cli, proxy] of [[placeholder, "2.43.0"], ["2.43.0", placeholder], [placeholder, placeholder]]) {
      const skew = computeVersionSkew(cli!, proxy!);
      expect(skew.skewed).toBe(false);
      expect(skew.warning).toBeNull();
      expect(isConfirmedVersionMatch(skew)).toBe(false);
    }
  });

  test("stays quiet when the versions match", () => {
    const skew = computeVersionSkew("2.35.0", "2.35.0");
    expect(skew.skewed).toBe(false);
    expect(skew.warning).toBeNull();
    expect(isConfirmedVersionMatch(skew)).toBe(true);
  });

  test("stays quiet when nothing is live", () => {
    const skew = computeVersionSkew("2.35.0", undefined);
    expect(skew.skewed).toBe(false);
    expect(skew.proxyVersion).toBeNull();
    expect(skew.warning).toBeNull();
    expect(isConfirmedVersionMatch(skew)).toBe(false);
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
