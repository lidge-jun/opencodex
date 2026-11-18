import { describe, expect, test } from "bun:test";
import { readVersionSources } from "../../scripts/release-version-sources";
import { compareVersions, devReleaseVersion } from "../../scripts/version-line";
import { repoRoot } from "../helpers/repo-root";

describe("release version line", () => {
  test("the committed base is plain and consistent across all four sources", () => {
    const sources = readVersionSources(repoRoot());
    expect(sources).toHaveLength(4);
    const base = sources[0]?.version;
    expect(base).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sources.map(source => source.version)).toEqual([base, base, base, base]);
  });

  test("a published stable can equal or exceed the committed base without a dev bump", () => {
    const base = "2.100.0";
    const stable = devReleaseVersion({ base, stableTags: ["v2.100.0"], previewTags: [], channel: "latest" });
    const preview = devReleaseVersion({ base, stableTags: ["v2.100.1"], previewTags: [], channel: "preview", stamp: "20261108" });
    expect(stable).toBe("2.100.1");
    expect(preview).toBe("2.100.2-preview.20261108.1");
    expect(compareVersions(preview, "2.100.1")).toBeGreaterThan(0);
  });
});
