import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderIndex, runStructureChecks, type Manifest } from "../../scripts/structure-ssot";
import { repoRoot } from "../helpers/repo-root";

/**
 * structure/ is a second description of this tree, and a second description drifts. Before this gate
 * existed nothing read the folder: four paths it named had already been moved or deleted, two docs
 * shared the number 09, and one file had grown to 1,860 lines.
 *
 * The negative cases below exist because a guard nobody has driven red is a guard nobody has tested.
 * The first revision of this file proved exactly one rule and shipped ten unproven ones; a review
 * pass found several of those could not fail at all.
 */

const BT = "\u0060";
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

function manifestOf(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "structure/manifest.json"), "utf8")) as Manifest;
}

function saveManifest(root: string, manifest: Manifest): void {
  write(root, "structure/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  write(root, "structure/INDEX.md", renderIndex(manifest));
}

/** A synthetic tree that passes every check, so each negative case isolates one rule. */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-structure-ssot-"));
  scratch.push(root);
  write(root, "src/alpha/keep.ts", "export const keep = 1;\n");
  write(root, "tests/alpha/alpha.test.ts", "// Holds INV-A-01\nexport {};\n");
  // The generated index names the sibling documentation roots and links the rules file, so a
  // scaffold without them fails on the index rather than on the rule under test.
  for (const root_dir of ["docs", "docs-site", "devlog"]) write(root, root_dir + "/.gitkeep", "");
  write(root, "structure/AGENTS.md", "# Rules\n");
  const manifest: Manifest = {
    version: 2,
    sizeBudgetLines: 600,
    generatedPaths: [],
    absentPaths: [],
    tiers: [{ id: 1, name: "Foundation", purpose: "only tier" }],
    docs: [{ path: "overview.md", tier: 1, title: "Overview", scope: "scope", documents: ["src/alpha/"] }],
    grace: { undocumentedSourceAreas: [], unboundInvariants: [], oversizeDocs: [], staleRefs: [] },
  };
  write(
    root,
    "structure/overview.md",
    [
      "# Overview",
      "",
      "## Non-negotiable invariants",
      "",
      "- **INV-A-01** — alpha keeps working.",
      "  Enforced by " + BT + "tests/alpha/alpha.test.ts" + BT + ".",
      "",
      "> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)",
      "",
    ].join("\n"),
  );
  write(
    root,
    "structure/decisions/ADR-0001-alpha.md",
    "# ADR-0001 — alpha\n\n- Contract owner: [overview.md](../overview.md#non-negotiable-invariants)\n",
  );
  saveManifest(root, manifest);
  return root;
}

const fires = (root: string, needle: string): void => {
  expect(runStructureChecks(root).join("\n")).toContain(needle);
};

describe("structure/ SSOT", () => {
  test("the maintainer docs still describe this tree", () => {
    expect(runStructureChecks(repoRoot())).toEqual([]);
  });

  test("the scaffold used by the negative cases is itself clean", () => {
    expect(runStructureChecks(scaffold())).toEqual([]);
  });

  test("a doc on disk that the manifest does not list", () => {
    const root = scaffold();
    write(root, "structure/orphan.md", "# Orphan\n");
    fires(root, "structure/orphan.md is not listed in manifest.json");
  });

  test("a manifest doc that is not on disk", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.docs.push({ path: "ghost.md", tier: 1, title: "Ghost", scope: "s", documents: [] });
    saveManifest(root, manifest);
    fires(root, "manifest.json lists structure/ghost.md but the file is missing");
  });

  test("a filename that smuggles ordering back in", () => {
    for (const name of ["01_overview.md", "01-overview.md", "deep/nested/doc.md"]) {
      const root = scaffold();
      const manifest = manifestOf(root);
      manifest.docs[0]!.path = name;
      write(root, "structure/" + name, "# Moved\n");
      rmSync(join(root, "structure/overview.md"));
      saveManifest(root, manifest);
      fires(root, "must be kebab-case");
    }
  });

  test("a doc over the line budget", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.sizeBudgetLines = 5;
    saveManifest(root, manifest);
    write(root, "structure/overview.md", readFileSync(join(root, "structure/overview.md"), "utf8") + "filler\n".repeat(20));
    fires(root, "over the 5-line budget");
  });

  test("a grace entry that outlived the split it promised", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.grace.oversizeDocs = ["overview.md"];
    saveManifest(root, manifest);
    fires(root, "drop the grace entry");
  });

  test("a link that does not resolve", () => {
    const root = scaffold();
    write(root, "structure/overview.md", "# Overview\n\n[gone](missing.md)\n");
    fires(root, "links missing.md, which does not exist");
  });

  test("a link whose anchor does not exist", () => {
    const root = scaffold();
    write(root, "structure/decisions/ADR-0001-alpha.md", "# ADR-0001\n\n- Owner: [overview.md](../overview.md#no-such-heading)\n");
    fires(root, "that heading anchor does not exist");
  });

  test("a repository path the tree does not have", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    write(root, "structure/overview.md", body + "\nSee " + BT + "src/nowhere/thing.ts" + BT + ".\n");
    fires(root, "which this tree does not have");
  });

  test("a decision record is not held against the present tree", () => {
    const root = scaffold();
    const adr = readFileSync(join(root, "structure/decisions/ADR-0001-alpha.md"), "utf8");
    write(root, "structure/decisions/ADR-0001-alpha.md", adr + "\nIt named " + BT + "src/nowhere/thing.ts" + BT + " at the time.\n");
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("a path named only inside a fenced example is not held against the tree", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    const fence = BT.repeat(3);
    write(root, "structure/overview.md", body + "\n" + fence + "text\n" + BT + "src/nowhere/thing.ts" + BT + "\n" + fence + "\n");
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("inline decision-log reasoning that crept back into a doc body", () => {
    for (const line of ["[Decision Log]", "**[decision log]**", "- 목적과 의도: 무언가"]) {
      const root = scaffold();
      const body = readFileSync(join(root, "structure/overview.md"), "utf8");
      write(root, "structure/overview.md", body + "\n" + line + "\n");
      fires(root, "carries inline decision-log reasoning");
    }
  });

  test("a decision record with no owner", () => {
    const root = scaffold();
    write(root, "structure/decisions/ADR-0002-lonely.md", "# ADR-0002\n");
    fires(root, "ADR-0002-lonely.md is not linked from any doc");
  });

  test("a decision record claimed by two docs", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.docs.push({ path: "second.md", tier: 1, title: "Second", scope: "s", documents: [] });
    write(root, "structure/second.md", "# Second\n\n> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)\n");
    saveManifest(root, manifest);
    fires(root, "a record has one owner");
  });

  test("a reused decision-record number", () => {
    const root = scaffold();
    write(root, "structure/decisions/ADR-0001-twin.md", "# ADR-0001 twin\n");
    fires(root, "decision record number 0001 is used twice");
  });

  test("a doc naming the same record twice still has one owner", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    write(root, "structure/overview.md", body + "\nAlso see [ADR-0001](decisions/ADR-0001-alpha.md).\n");
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("an invariant with no binding and no recorded reason", () => {
    const root = scaffold();
    write(
      root,
      "structure/overview.md",
      "# Overview\n\n## Non-negotiable invariants\n\n- **INV-A-01** — alpha keeps working.\n\n> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)\n",
    );
    fires(root, "INV-A-01 has no Enforced by binding");
  });

  test("an invariant that is both bound and graced", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.grace.unboundInvariants = [{ id: "INV-A-01", reason: "no test pins it yet" }];
    saveManifest(root, manifest);
    fires(root, "also listed in grace.unboundInvariants");
  });

  test("an invariant whose test is gone", () => {
    const root = scaffold();
    rmSync(join(root, "tests/alpha/alpha.test.ts"));
    fires(root, "INV-A-01 names tests/alpha/alpha.test.ts, which this tree does not have");
  });

  test("a test that no longer names its invariant, including a longer id that merely starts the same", () => {
    const silent = scaffold();
    write(silent, "tests/alpha/alpha.test.ts", "export {};\n");
    fires(silent, "does not name INV-A-01");

    const prefixed = scaffold();
    write(prefixed, "tests/alpha/alpha.test.ts", "// Holds INV-A-011\nexport {};\n");
    fires(prefixed, "does not name INV-A-01");
  });

  test("a src area nobody describes", () => {
    const root = scaffold();
    write(root, "src/beta/new.ts", "export const beta = 1;\n");
    fires(root, "src/beta/ is described by no doc");
  });

  test("a top-level src module nobody describes", () => {
    const root = scaffold();
    write(root, "src/orphan-module.ts", "export const x = 1;\n");
    fires(root, "src/orphan-module.ts is described by no doc");
  });

  test("an area that is both described and graced", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.grace.undocumentedSourceAreas = [{ path: "src/alpha/", reason: "conflicting" }];
    saveManifest(root, manifest);
    fires(root, "is both described and listed as undescribed");
  });

  test("a described area that does not exist", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.docs[0]!.documents.push("src/imaginary/");
    saveManifest(root, manifest);
    fires(root, "claims src/imaginary/, which this tree does not have");
  });

  test("INDEX.md that drifted from the manifest", () => {
    const root = scaffold();
    write(root, "structure/INDEX.md", "# hand-edited\n");
    fires(root, "drifted from manifest.json");
  });

  test("INDEX.md in this repository is the generated file", () => {
    const root = repoRoot();
    expect(readFileSync(join(root, "structure/INDEX.md"), "utf8").replace(/\r\n/g, "\n")).toBe(renderIndex(manifestOf(root)));
  });
});
