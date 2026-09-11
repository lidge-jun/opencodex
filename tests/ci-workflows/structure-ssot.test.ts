import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndex, runStructureChecks, type Manifest } from "../../scripts/structure-ssot";
import { repoRoot } from "../helpers/repo-root";

/**
 * structure/ is a second description of this tree, and a second description is free to drift from
 * the first. Before this gate existed nothing read the folder: four paths it named had already been
 * moved or deleted, two docs shared the number 09, and one file had grown to 1,860 lines.
 *
 * The checks live in scripts/structure-ssot.ts so a maintainer can run them directly
 * (bun run structure:check); this file is what makes them block CI.
 */
describe("structure/ SSOT", () => {
  test("the maintainer docs still describe this tree", () => {
    expect(runStructureChecks(repoRoot())).toEqual([]);
  });

  test("INDEX.md is generated from the manifest, not hand-written", () => {
    const root = repoRoot();
    const manifest = JSON.parse(readFileSync(join(root, "structure/manifest.json"), "utf8")) as Manifest;
    const onDisk = readFileSync(join(root, "structure/INDEX.md"), "utf8").replace(/\r\n/g, "\n");
    expect(onDisk).toBe(renderIndex(manifest));
  });

  test("the gate is not vacuous: a declared doc that is not on disk fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ocx-structure-ssot-"));
    try {
      mkdirSync(join(tmp, "structure"), { recursive: true });
      const manifest: Manifest = {
        version: 1,
        sizeBudgetLines: 600,
        generatedPaths: [],
        absentPaths: [],
        tiers: [{ id: 1, name: "Foundation", purpose: "only tier" }],
        docs: [{ path: "overview.md", tier: 1, title: "Overview", scope: "scope", owns: [] }],
        grace: { unownedSourceAreas: [], oversizeDocs: [], staleRefs: [] },
      };
      writeFileSync(join(tmp, "structure/manifest.json"), JSON.stringify(manifest), "utf8");
      const failures = runStructureChecks(tmp);
      expect(failures.some((f) => f.includes("structure/overview.md but the file is missing"))).toBe(true);
      expect(failures.some((f) => f.includes("INDEX.md is missing"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
