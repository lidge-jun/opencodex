import { describe, expect, test } from "bun:test";
import {
  compareTagsLenient,
  compareVersions,
  nextDevelopmentVersion,
  nextPreviewRelease,
  nextStableRelease,
  parseVersion,
} from "../../scripts/version-line";

describe("version line algebra", () => {
  test("parses optional v, prerelease identifiers, and ignored build metadata", () => {
    expect(parseVersion(" v2.36.0-preview.20260829+build.1 ")).toEqual({
      major: 2,
      minor: 36,
      patch: 0,
      prerelease: ["preview", "20260829"],
    });
    expect(parseVersion("2.36.0+build.1")).toEqual({
      major: 2,
      minor: 36,
      patch: 0,
      prerelease: null,
    });
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("2.36")).toBeNull();
    expect(parseVersion("garbage")).toBeNull();
  });

  test("orders SemVer cores and prerelease identifiers", () => {
    expect(compareVersions("2.36.0-preview.2", "2.36.0-preview.10")).toBeLessThan(0);
    expect(compareVersions("2.36.0-preview.10", "2.36.0-preview.beta")).toBeLessThan(0);
    expect(compareVersions("2.36.0-preview.1", "2.36.0")).toBeLessThan(0);
    expect(compareVersions("2.37.0-preview.1", "2.36.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.36.0", "2.36.0")).toBe(0);
  });

  test("ignores build metadata for strict release precedence", () => {
    expect(compareVersions("2.19.4", "2.19.3+build.1")).toBeGreaterThan(0);
    expect(compareVersions("2.19.3", "2.19.3+build.1")).toBe(0);
    expect(() => compareVersions("2.19.4", "not-a-version")).toThrow(/unparseable/);
  });

  test("keeps historical tag sorting lenient while release decisions fail closed", () => {
    const fallback = "vNOTAVERSION".localeCompare("v2.42.0", undefined, {
      numeric: true,
      sensitivity: "base",
    });
    expect(compareTagsLenient("vNOTAVERSION", "v2.42.0")).toBe(fallback);
    expect(() => compareVersions("vNOTAVERSION", "v2.42.0")).toThrow(/unparseable/);
  });

  test("a stable release is succeeded by the next minor", () => {
    expect(nextDevelopmentVersion("2.36.0")).toBe("2.37.0");
    expect(nextDevelopmentVersion("2.33.0")).toBe("2.34.0");
    expect(nextDevelopmentVersion("v2.36.0")).toBe("2.37.0");
  });

  test("a prerelease is succeeded by its own stable core", () => {
    expect(nextDevelopmentVersion("2.36.0-preview.20260829")).toBe("2.36.0");
    expect(nextDevelopmentVersion("2.36.0-preview.20260829")).not.toBe("2.37.0");
    expect(nextDevelopmentVersion("v2.36.0-preview.20260829")).toBe("2.36.0");
  });

  test("refuses malformed released versions instead of guessing", () => {
    expect(() => nextDevelopmentVersion("not-a-version")).toThrow(/not parseable/);
    expect(() => nextDevelopmentVersion("2.36")).toThrow(/not parseable/);
    expect(() => nextDevelopmentVersion("garbage")).toThrow(/not parseable/);
  });

  test("a future same-core preview does not raise the stable bump base", () => {
    expect(nextStableRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTags: ["v2.43.0-preview.1"],
    })).toBe("2.43.0");
  });

  test("refuses a stable patch below an open higher-core preview", () => {
    expect(() => nextStableRelease({
      kind: "patch",
      stableTip: "2.42.0",
      stableTags: [],
      previewTags: ["v2.43.0-preview.1"],
    })).toThrow(/cannot bump stable patch.*v2\.43\.0-preview\.1/);
  });

  test("allows a stable patch when no higher-core preview is open", () => {
    expect(nextStableRelease({
      kind: "patch",
      stableTip: "2.42.0",
      stableTags: [],
      previewTags: ["v2.42.0-preview.9"],
    })).toBe("2.42.1");
  });

  test("starts the next preview core above the latest stable", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: null,
      previewTags: [],
      stamp: "20260904",
    })).toBe("2.43.0-preview.20260904");
  });

  test("adds an ordinal when the same-core preview stamp already exists", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: null,
      previewTags: ["v2.43.0-preview.20260904"],
      stamp: "20260904",
    })).toBe("2.43.0-preview.20260904.2");
  });

  test("honours the preview bump kind when resolving its core", () => {
    expect(nextPreviewRelease({
      kind: "major",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: null,
      previewTags: [],
      stamp: "20260904",
    })).toBe("3.0.0-preview.20260904");
  });

  test("continues the ordinal from the incumbent", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: null,
      previewTags: ["v2.43.0-preview.20260904.3"],
      stamp: "20260904",
    })).toBe("2.43.0-preview.20260904.4");
  });

  test("uses an equal-stamp npm preview tip as the incumbent", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: "2.43.0-preview.20260910",
      previewTags: [],
      stamp: "20260910",
    })).toBe("2.43.0-preview.20260910.2");
  });

  test("uses an equal-stamp preview tag as the incumbent when the npm tip is behind", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: "2.40.0-preview.20260902",
      previewTags: ["v2.43.0-preview.20260910"],
      stamp: "20260910",
    })).toBe("2.43.0-preview.20260910.2");
  });

  test("refuses a preview stamp older than the incumbent stamp", () => {
    expect(() => nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: "2.43.0-preview.20260910",
      previewTags: [],
      stamp: "20260904",
    })).toThrow(/20260904.*20260910/);
  });

  test("uses stable tags rather than the preview channel to resolve the preview core", () => {
    expect(nextPreviewRelease({
      kind: "minor",
      stableTip: "2.40.0",
      stableTags: ["v2.42.0"],
      previewTip: "2.40.0-preview.20260902",
      previewTags: [],
      stamp: "20260904",
    })).toBe("2.43.0-preview.20260904");
  });

  test("promotes a same-core preview to the intended stable version", () => {
    expect(nextStableRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTags: ["v2.43.0-preview.20260904"],
    })).toBe("2.43.0");
  });

  test("a preview successor strictly outranks its incumbent", () => {
    const incumbent = "v2.43.0-preview.20260904.3";
    const result = nextPreviewRelease({
      kind: "minor",
      stableTip: "2.42.0",
      stableTags: [],
      previewTip: null,
      previewTags: [incumbent],
      stamp: "20260904",
    });
    expect(compareVersions(result, incumbent)).toBeGreaterThan(0);
  });
});
