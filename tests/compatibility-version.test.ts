import { describe, expect, test } from "bun:test";
import { buildCompatibilityVersionManifest } from "../scripts/generate-compatibility-version";

describe("Compatibility Lab generated implementation identity", () => {
  test("manifest covers exact tracked source authority without self-reference", () => {
    const manifest = buildCompatibilityVersionManifest(process.cwd());
    const paths = manifest.files.map(row => row.path);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.assertionDslVersion).toBe("1.0.0");
    expect(manifest.evidenceSchemaVersion).toBe("1.0.0");
    expect(manifest.bunRuntimeVersion).toBe(Bun.version);
    expect(paths).toContain("package.json");
    expect(paths).toContain("bun.lock");
    expect(paths).toContain("scripts/model-metadata.source.json");
    expect(paths).toContain("src/routing/compatibility/version.ts");
    expect(paths).not.toContain("src/generated/compatibility-version.json");
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    for (const row of manifest.files) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
