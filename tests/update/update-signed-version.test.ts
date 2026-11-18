import { describe, expect, test } from "bun:test";
import { sameSignedVersion, trustedCommentMatchesVersion } from "../../src/update/update-signed-version.mjs";

describe("signed update version equality", () => {
  test("preserves full version identity and permits one signed v prefix", () => {
    expect(sameSignedVersion("1.2.3-preview.1+build.7", "v1.2.3-preview.1+build.7")).toBe(true);
    expect(sameSignedVersion("1.2.3+one", "1.2.3+two")).toBe(false);
    expect(sameSignedVersion("1.2.3-preview.1", "1.2.3-preview.2")).toBe(false);
    expect(sameSignedVersion("1.2.3", "vv1.2.3")).toBe(false);
    expect(sameSignedVersion("v1.2.3", "1.2.3")).toBe(false);
  });

  test("uses the common lossless core domain and rejects malformed SemVer", () => {
    const max = "18446744073709551615.0.0";
    expect(sameSignedVersion(max, `v${max}`)).toBe(true);
    for (const bad of ["18446744073709551616.0.0", "01.0.0", "1.2.3-01", "1.2.3+", "1.2.3\n", "1.2.3-ä", "1.2.3-" + "x".repeat(64)]) {
      expect(sameSignedVersion(bad, bad)).toBe(false);
      expect(sameSignedVersion("1.2.3", bad)).toBe(false);
    }
  });

  test("requires exactly one matching version field in the authenticated comment", () => {
    expect(trustedCommentMatchesVersion("timestamp:1\tfile:app.tar.gz\tversion:v1.2.3+build", "1.2.3+build")).toBe(true);
    for (const comment of ["timestamp:1\tfile:app", "version:", "version:1.2.3\tversion:1.2.3", "version:1.2.3+other", "xversion:1.2.3", "version:vv1.2.3"]) {
      expect(trustedCommentMatchesVersion(comment, "1.2.3+build")).toBe(false);
    }
    expect(trustedCommentMatchesVersion("version:1.2.3\tversion:1.2.3", "1.2.3")).toBe(false);
  });
});
