import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadManifest, renderIndex, runStructureChecks, writeGeneratedIndex, type Manifest } from "../../scripts/structure-ssot";
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
      "Alpha lives in " + BT + "src/alpha/keep.ts" + BT + ".",
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

/** Add one valid authority and a second doc that preserves many-to-many source review. */
function contractScaffold(): string {
  const root = scaffold();
  const manifest = manifestOf(root);
  manifest.docs.push({ path: "second.md", tier: 1, title: "Second", scope: "second scope", documents: ["src/alpha/"] });
  manifest.contracts = {
    version: 1,
    entries: [
      {
        id: "alpha-contract",
        owner: { document: "overview.md", anchor: "non-negotiable-invariants" },
        dependents: ["second.md"],
      },
    ],
  };
  write(
    root,
    "structure/second.md",
    "# Second\n\nAlpha uses " + BT + "src/alpha/keep.ts" + BT + ".\n\nSee the [alpha contract](overview.md#non-negotiable-invariants).\n",
  );
  saveManifest(root, manifest);
  return root;
}

const fires = (root: string, needle: string): void => {
  expect(runStructureChecks(root).join("\n")).toContain(needle);
};

/**
 * The negative cases above run in a plain temp directory, where git has no index and the gate falls
 * back to the filesystem. That leaves the index branch — the one the module argues hardest for —
 * untested, so these cases build a real repository and drive it.
 */
function gitScaffold(): string {
  const root = scaffold();
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
  stage(root);
  return root;
}

function stage(root: string): void {
  expect(Bun.spawnSync(["git", "add", "-A"], { cwd: root }).exitCode).toBe(0);
}

describe("structure/ SSOT", () => {
  test("the maintainer docs still describe this tree", () => {
    expect(runStructureChecks(repoRoot())).toEqual([]);
  });

  test("the scaffold used by the negative cases is itself clean", () => {
    expect(runStructureChecks(scaffold())).toEqual([]);
  });

  test("contracts are optional", () => {
    const root = scaffold();
    expect(manifestOf(root).contracts).toBeUndefined();
    expect(runStructureChecks(root)).toEqual([]);
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

  test("a described area the doc never names", () => {
    const root = scaffold();
    write(root, "src/beta/new.ts", "export const beta = 1;\n");
    const manifest = manifestOf(root);
    manifest.docs[0]!.documents.push("src/beta/");
    saveManifest(root, manifest);
    fires(root, "claims src/beta/ but never names it or a path in it");
  });

  test("a fragment-only link that names no heading in its own document", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    write(root, "structure/overview.md", body + "\nSee [that rule](#no-such-heading).\n");
    fires(root, "links #no-such-heading, but that heading anchor does not exist");
  });

  test("overview.md missing fails instead of silencing every invariant check", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.docs = [];
    saveManifest(root, manifest);
    rmSync(join(root, "structure/overview.md"));
    fires(root, "structure/overview.md is missing");
  });

  test("a record named in prose but not linked is not owned", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8").replace(
      "> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)",
      "The reasoning sits in decisions/ADR-0001-alpha.md for anyone curious.",
    );
    write(root, "structure/overview.md", body);
    fires(root, "ADR-0001-alpha.md is not linked from any doc");
  });

  test("a bare filename is not treated as a repository path", () => {
    const root = scaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    write(root, "structure/overview.md", body + "\nCodex reads " + BT + "models_cache.json" + BT + " at startup.\n");
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("contract manifest shapes fail with actionable errors", () => {
    const valid = manifestOf(scaffold());
    const cases: [unknown, string][] = [
      [[], "contracts must be an object"],
      [{ version: 2, entries: [] }, "contracts.version must be 1"],
      [{ version: 1, entries: {} }, "contracts.entries must be an array"],
      [{ version: 1, entries: [{ id: "Not Kebab", owner: {}, dependents: [] }] }, "id must be a kebab-case string"],
      [{ version: 1, entries: [{ id: "valid-id", owner: null, dependents: [] }] }, "owner must be an object"],
      [{ version: 1, entries: [{ id: "valid-id", owner: { document: 1, anchor: 2 }, dependents: [] }] }, "owner.document must be a string"],
      [{ version: 1, entries: [{ id: "valid-id", owner: { document: "overview.md", anchor: "overview" }, dependents: {} }] }, "dependents must be an array"],
      [{ version: 1, entries: [{ id: "valid-id", owner: { document: "overview.md", anchor: "overview" }, dependents: [1] }] }, "dependents[0] must be a string"],
    ];
    for (const [contracts, needle] of cases) {
      const loaded = loadManifest(JSON.stringify({ ...valid, contracts }));
      expect(loaded).toHaveProperty("error");
      expect((loaded as { error: string }).error).toContain(needle);
    }
  });

  test("duplicate contract ids are rejected", () => {
    const root = contractScaffold();
    const manifest = manifestOf(root);
    manifest.contracts!.entries.push({
      id: "alpha-contract",
      owner: { document: "overview.md", anchor: "non-negotiable-invariants" },
      dependents: [],
    });
    saveManifest(root, manifest);
    fires(root, "contract alpha-contract is declared twice");
  });

  test("contract owners must be declared files with real anchors", () => {
    const undeclared = contractScaffold();
    const undeclaredManifest = manifestOf(undeclared);
    undeclaredManifest.contracts!.entries[0]!.owner.document = "ghost.md";
    saveManifest(undeclared, undeclaredManifest);
    fires(undeclared, "owner ghost.md is not a declared structure document");

    const missing = contractScaffold();
    const missingManifest = manifestOf(missing);
    missingManifest.docs.push({ path: "ghost.md", tier: 1, title: "Ghost", scope: "ghost", documents: [] });
    missingManifest.contracts!.entries[0]!.owner.document = "ghost.md";
    saveManifest(missing, missingManifest);
    fires(missing, "owner structure/ghost.md is missing");

    const anchor = contractScaffold();
    const anchorManifest = manifestOf(anchor);
    anchorManifest.contracts!.entries[0]!.owner.anchor = "missing-heading";
    saveManifest(anchor, anchorManifest);
    fires(anchor, "owner structure/overview.md has no #missing-heading heading anchor");
  });

  test("contract dependents must be unique declared files distinct from the owner", () => {
    const duplicate = contractScaffold();
    const duplicateManifest = manifestOf(duplicate);
    duplicateManifest.contracts!.entries[0]!.dependents.push("second.md");
    saveManifest(duplicate, duplicateManifest);
    fires(duplicate, "lists dependent second.md twice");

    const owner = contractScaffold();
    const ownerManifest = manifestOf(owner);
    ownerManifest.contracts!.entries[0]!.dependents = ["overview.md"];
    saveManifest(owner, ownerManifest);
    fires(owner, "lists its owner overview.md as a dependent");

    const undeclared = contractScaffold();
    const undeclaredManifest = manifestOf(undeclared);
    undeclaredManifest.contracts!.entries[0]!.dependents = ["ghost.md"];
    saveManifest(undeclared, undeclaredManifest);
    fires(undeclared, "dependent ghost.md is not a declared structure document");

    const missing = contractScaffold();
    const missingManifest = manifestOf(missing);
    missingManifest.docs.push({ path: "ghost.md", tier: 1, title: "Ghost", scope: "ghost", documents: [] });
    missingManifest.contracts!.entries[0]!.dependents = ["ghost.md"];
    saveManifest(missing, missingManifest);
    fires(missing, "dependent structure/ghost.md is missing");
  });

  test("a contract dependent must link the exact owner anchor", () => {
    const root = contractScaffold();
    write(root, "structure/second.md", "# Second\n\nAlpha uses " + BT + "src/alpha/keep.ts" + BT + ".\n\nSee [Overview](overview.md).\n");
    fires(root, "dependent structure/second.md does not link overview.md#non-negotiable-invariants");
  });

  test("a valid contract keeps many-to-many source review", () => {
    const root = contractScaffold();
    expect(runStructureChecks(root)).toEqual([]);
    expect(renderIndex(manifestOf(root))).toContain(
      "| " + BT + "src/alpha/" + BT + " | [" + BT + "overview.md" + BT + "](overview.md)<br>[" + BT + "second.md" + BT + "](second.md) |",
    );
  });

  test("contract navigation has deterministic ordering and placement", () => {
    const root = contractScaffold();
    const manifest = manifestOf(root);
    manifest.docs.push({ path: "third.md", tier: 1, title: "Third", scope: "third scope", documents: [] });
    manifest.contracts!.entries = [
      {
        id: "zeta-contract",
        owner: { document: "overview.md", anchor: "non-negotiable-invariants" },
        dependents: [],
      },
      {
        id: "alpha-contract",
        owner: { document: "overview.md", anchor: "non-negotiable-invariants" },
        dependents: ["third.md", "second.md"],
      },
    ];
    const rendered = renderIndex(manifest);
    const contracts = rendered.indexOf("## Cross-cutting contracts");
    const decisions = rendered.indexOf("## Decision records");
    const alpha = rendered.indexOf("| " + BT + "alpha-contract" + BT + " |");
    const zeta = rendered.indexOf("| " + BT + "zeta-contract" + BT + " |");
    expect(contracts).toBeGreaterThan(rendered.indexOf("### Not described by any doc"));
    expect(decisions).toBeGreaterThan(contracts);
    expect(alpha).toBeGreaterThan(contracts);
    expect(zeta).toBeGreaterThan(alpha);
    expect(rendered.slice(alpha, zeta)).toContain(
      "[" + BT + "second.md" + BT + "](second.md)<br>[" + BT + "third.md" + BT + "](third.md)",
    );
    expect(rendered).toContain(
      "[" + BT + "overview.md#non-negotiable-invariants" + BT + "](overview.md#non-negotiable-invariants)",
    );
    expect(rendered.slice(zeta, decisions)).toContain("| — |");
  });

  test("contract checks validate topology rather than owner prose", () => {
    const root = contractScaffold();
    const owner = readFileSync(join(root, "structure/overview.md"), "utf8").replace("alpha keeps working", "alpha remains available");
    write(root, "structure/overview.md", owner);
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("a malformed manifest is an actionable failure, not a stack trace", () => {
    expect(loadManifest("{not json")).toHaveProperty("error");
    const shapeless = loadManifest(JSON.stringify({ sizeBudgetLines: 600 }));
    expect(shapeless).toHaveProperty("error");
    expect((shapeless as { error: string }).error).toContain("docs must be an array");

    const root = scaffold();
    write(root, "structure/manifest.json", "{not json");
    fires(root, "is not valid JSON");
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

  test("a tracked tree is judged by the index: a case variant is named, not silently accepted", () => {
    const root = gitScaffold();
    expect(runStructureChecks(root)).toEqual([]);
    const body = readFileSync(join(root, "structure/overview.md"), "utf8").replace(
      BT + "src/alpha/keep.ts" + BT,
      BT + "src/Alpha/keep.ts" + BT,
    );
    write(root, "structure/overview.md", body);
    stage(root);
    fires(root, "but the tracked path is src/alpha/keep.ts");
  });

  test("a tracked tree rejects an untracked leftover that CI would never see", () => {
    const root = gitScaffold();
    const body = readFileSync(join(root, "structure/overview.md"), "utf8");
    write(root, "src/alpha/scratch.ts", "export const scratch = 1;\n");
    write(root, "structure/overview.md", body + "\nAlso " + BT + "src/alpha/scratch.ts" + BT + ".\n");
    // overview.md is staged so the reference is read; scratch.ts deliberately is not.
    expect(Bun.spawnSync(["git", "add", "structure/overview.md"], { cwd: root }).exitCode).toBe(0);
    fires(root, "names src/alpha/scratch.ts, which this tree does not have");
  });

  test("a record shown inside a fenced example is not a second owner", () => {
    const root = scaffold();
    const manifest = manifestOf(root);
    manifest.docs.push({ path: "second.md", tier: 1, title: "Second", scope: "s", documents: [] });
    const fence = BT.repeat(3);
    write(root, "structure/second.md", "# Second\n\n" + fence + "text\n> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)\n" + fence + "\n");
    saveManifest(root, manifest);
    expect(runStructureChecks(root)).toEqual([]);
  });

  test("a Decision record line pointing outside decisions/ is rejected", () => {
    const root = scaffold();
    write(root, "structure/elsewhere.md", "# Elsewhere\n");
    const body = readFileSync(join(root, "structure/overview.md"), "utf8").replace(
      "> Decision record: [ADR-0001](decisions/ADR-0001-alpha.md)",
      "> Decision record: [ADR-0001](elsewhere.md)",
    );
    write(root, "structure/overview.md", body);
    fires(root, "which is not in decisions/");
  });

  test("a malformed grace element is a failure line, not a thrown TypeError", () => {
    const root = scaffold();
    const manifest = manifestOf(root) as unknown as { absentPaths: unknown[] };
    manifest.absentPaths = ["go/"];
    write(root, "structure/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    fires(root, "absentPaths[0].path must be a string");
  });

  test("index generation validates the manifest before writing", () => {
    const root = scaffold();
    const before = readFileSync(join(root, "structure/INDEX.md"), "utf8");
    const manifest = manifestOf(root) as unknown as { contracts: unknown };
    manifest.contracts = { version: 1, entries: "not-an-array" };
    write(root, "structure/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const result = writeGeneratedIndex(root);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("contracts.entries must be an array");
    expect(readFileSync(join(root, "structure/INDEX.md"), "utf8")).toBe(before);
  });

  test("index generation rejects a malformed contract entry without a renderer crash", () => {
    const root = scaffold();
    const before = readFileSync(join(root, "structure/INDEX.md"), "utf8");
    const manifest = manifestOf(root) as unknown as { contracts: unknown };
    // A bare string entry used to reach the renderer's id comparator and throw a TypeError.
    manifest.contracts = { version: 1, entries: ["oops"] };
    write(root, "structure/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const result = writeGeneratedIndex(root);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("id must be a kebab-case string");
    expect(readFileSync(join(root, "structure/INDEX.md"), "utf8")).toBe(before);
  });

  // The seam-level tests above prove the helper; these two drive the real CLI tail, which is
  // where the original bug lived (parse + cast + render before validation). The script is
  // copied into the scaffold so its import.meta.dir resolves to the synthetic root.
  function scaffoldCli(root: string): void {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(join(repoRoot(), "scripts/structure-ssot.ts"), join(root, "scripts/structure-ssot.ts"));
  }

  test("CLI --fix fails malformed contracts with a named diagnostic and an unchanged index", () => {
    const root = scaffold();
    scaffoldCli(root);
    const before = readFileSync(join(root, "structure/INDEX.md"), "utf8");
    const manifest = manifestOf(root) as unknown as { contracts: unknown };
    manifest.contracts = { version: 1, entries: "not-an-array" };
    write(root, "structure/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    const result = Bun.spawnSync([process.execPath, "scripts/structure-ssot.ts", "--fix"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("contracts.entries must be an array");
    expect(stderr).not.toContain("TypeError");
    expect(readFileSync(join(root, "structure/INDEX.md"), "utf8")).toBe(before);
  });

  test("CLI --fix regenerates a stale index for a valid manifest", () => {
    const root = scaffold();
    scaffoldCli(root);
    write(root, "structure/INDEX.md", "# stale\n");
    const result = Bun.spawnSync([process.execPath, "scripts/structure-ssot.ts", "--fix"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const regenerated = readFileSync(join(root, "structure/INDEX.md"), "utf8");
    expect(regenerated).not.toBe("# stale\n");
    expect(regenerated).toBe(renderIndex(manifestOf(root)));
  });
});
