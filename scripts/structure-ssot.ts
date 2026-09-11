#!/usr/bin/env bun
/**
 * structure/ single-source-of-truth gate.
 *
 * The maintainer docs under structure/ are only worth trusting if a machine can prove they still
 * describe this tree. This module owns that proof: it validates the doc map, the source-ownership
 * map, decision-record extraction, invariant-to-test bindings, and every path the docs name, and it
 * generates structure/INDEX.md so the reading order cannot contradict the manifest.
 *
 * Usage:
 *   bun scripts/structure-ssot.ts            # report findings, exit 1 on failure
 *   bun scripts/structure-ssot.ts --fix      # rewrite structure/INDEX.md from the manifest
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const BT = "\u0060";

export type Manifest = {
  version: number;
  sizeBudgetLines: number;
  generatedPaths: string[];
  absentPaths: { path: string; reason: string }[];
  tiers: { id: number; name: string; purpose: string }[];
  docs: { path: string; tier: number; title: string; scope: string; owns: string[] }[];
  grace: {
    unownedSourceAreas: { path: string; reason: string }[];
    oversizeDocs: string[];
    staleRefs: string[];
  };
};

const REPO_ROOTS = ["src", "tests", "gui", "scripts", "docs", "docs-site", "bin", "go", "devlog", ".github"];
const GENERATED_DOCS = ["INDEX.md"];
const RULE_DOCS = ["AGENTS.md"];

const toPosix = (p: string) => p.split("\\").join("/");
const trimSlash = (p: string) => p.replace(/\/+$/, "");

function listMarkdown(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, root, out);
    else if (entry.name.endsWith(".md")) out.push(toPosix(relative(root, full)));
  }
  return out.sort();
}

/** Render structure/INDEX.md from the manifest. The doc map never has a second author. */
export function renderIndex(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push("# opencodex Structure Index");
  lines.push("");
  lines.push(
    "This folder is the maintainer source of truth for the current system shape. Public user workflows",
  );
  lines.push(
    "belong in " + BT + "docs-site/" + BT + ". Development work is recorded in " + BT + "devlog/" + BT + " units — " + BT + "_plan/" + BT + " while open,",
  );
  lines.push(
    BT + "_fin/" + BT + " once closed — while " + BT + "docs/" + BT + " keeps investigations and diagnostic notes worth retaining for",
  );
  lines.push("archaeology, debugging, or source research.");
  lines.push("");
  lines.push(
    "Generated from " + BT + "structure/manifest.json" + BT + " by " + BT + "bun run structure:index" + BT + ". Do not edit by hand; " +
      BT + "bun run structure:check" + BT + " fails when this file and the manifest disagree. The rules for changing anything",
  );
  lines.push("in this folder are in [" + BT + "AGENTS.md" + BT + "](AGENTS.md).");
  lines.push("");
  lines.push("## Reading order");
  for (const tier of manifest.tiers) {
    const docs = manifest.docs.filter((d) => d.tier === tier.id);
    if (docs.length === 0) continue;
    lines.push("");
    lines.push("### Tier " + tier.id + " — " + tier.name);
    lines.push("");
    lines.push(tier.purpose);
    lines.push("");
    lines.push("| Doc | Scope |");
    lines.push("| --- | --- |");
    for (const doc of docs) {
      lines.push("| [" + BT + doc.path + BT + "](" + doc.path + ") | " + doc.scope + " |");
    }
  }
  lines.push("");
  lines.push("## Source ownership");
  lines.push("");
  lines.push(
    "One source area has exactly one owning doc. Changing an owned area obliges the same change to update",
  );
  lines.push("its doc; see [" + BT + "AGENTS.md" + BT + "](AGENTS.md).");
  lines.push("");
  lines.push("| Source path | Owning doc |");
  lines.push("| --- | --- |");
  const owned: { path: string; doc: string }[] = [];
  for (const doc of manifest.docs) for (const own of doc.owns) owned.push({ path: own, doc: doc.path });
  owned.sort((a, b) => a.path.localeCompare(b.path));
  for (const row of owned) {
    lines.push("| " + BT + row.path + BT + " | [" + BT + row.doc + BT + "](" + row.doc + ") |");
  }
  lines.push("");
  lines.push("### Deliberately unowned");
  lines.push("");
  lines.push("| Source path | Why |");
  lines.push("| --- | --- |");
  for (const row of [...manifest.grace.unownedSourceAreas].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push("| " + BT + row.path + BT + " | " + row.reason + " |");
  }
  lines.push("");
  lines.push("## Decision records");
  lines.push("");
  lines.push(
    "Superseded reasoning lives in " + BT + "decisions/" + BT + " as numbered records. A doc states the contract that holds now and",
  );
  lines.push("links the record that explains why; it never carries the reasoning inline.");
  lines.push("");
  return lines.join("\n") + "\n";
}

export function runStructureChecks(repoRoot: string): string[] {
  const structureDir = join(repoRoot, "structure");
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  const manifestPath = join(structureDir, "manifest.json");
  if (!existsSync(manifestPath)) return ["structure/manifest.json is missing"];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const present = listMarkdown(structureDir, structureDir);
  const sotOnDisk = present.filter(
    (p) => !p.startsWith("decisions/") && !GENERATED_DOCS.includes(p) && !RULE_DOCS.includes(p),
  );
  const declared = manifest.docs.map((d) => d.path);

  // 1. doc map parity
  for (const p of sotOnDisk) if (!declared.includes(p)) fail("structure/" + p + " is not listed in manifest.json");
  for (const p of declared) if (!sotOnDisk.includes(p)) fail("manifest.json lists structure/" + p + " but the file is missing");
  const seenDoc = new Set<string>();
  for (const p of declared) {
    if (seenDoc.has(p)) fail("manifest.json lists structure/" + p + " twice");
    seenDoc.add(p);
  }
  for (const doc of manifest.docs) {
    if (!manifest.tiers.some((t) => t.id === doc.tier)) fail("structure/" + doc.path + " claims unknown tier " + doc.tier);
    if (!/^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.md$/.test(doc.path)) {
      fail("structure/" + doc.path + " must be kebab-case and at most one directory deep");
    }
    if (/^[0-9]{2}_/.test(doc.path.split("/").pop() ?? "")) {
      fail("structure/" + doc.path + " uses a numeric prefix; ordering belongs to manifest.json");
    }
  }

  // 2. size budget
  for (const doc of manifest.docs) {
    const p = join(structureDir, doc.path);
    if (!existsSync(p)) continue;
    const count = readFileSync(p, "utf8").split("\n").length;
    if (count > manifest.sizeBudgetLines && !manifest.grace.oversizeDocs.includes(doc.path)) {
      fail(
        "structure/" + doc.path + " is " + count + " lines, over the " + manifest.sizeBudgetLines +
          "-line budget; split it or add it to grace.oversizeDocs with a plan",
      );
    }
  }
  for (const p of manifest.grace.oversizeDocs) {
    if (!declared.includes(p)) fail("grace.oversizeDocs names structure/" + p + ", which is not a declared doc");
  }

  // 3. links, repo paths, and the inline-decision ban
  const linkRe = /\]\(([^)\s]+)\)/g;
  const pathRe = new RegExp(BT + "((?:" + REPO_ROOTS.join("|") + ")/[A-Za-z0-9_.@/-]*)" + BT, "g");
  for (const rel of present) {
    const abs = join(structureDir, rel);
    const body = readFileSync(abs, "utf8");
    for (const line of body.split("\n")) {
      if (line.trim() === "[Decision Log]") {
        fail("structure/" + rel + " carries an inline [Decision Log]; move it to decisions/ and link the record");
      }
    }
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(body))) {
      const target = m[1];
      if (/^(?:https?|mailto):/.test(target) || target.startsWith("#")) continue;
      const resolved = resolve(dirname(abs), target.split("#")[0]);
      if (!existsSync(resolved)) fail("structure/" + rel + " links " + target + ", which does not exist");
    }
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(body))) {
      const named = trimSlash(m[1]);
      if (manifest.generatedPaths.some((g) => named === trimSlash(g) || named.startsWith(trimSlash(g) + "/"))) continue;
      if (manifest.absentPaths.some((a) => trimSlash(a.path) === named)) continue;
      if (manifest.grace.staleRefs.map(trimSlash).includes(named)) continue;
      if (!existsSync(join(repoRoot, named))) {
        fail("structure/" + rel + " names " + named + ", which does not exist in this tree");
      }
    }
  }
  for (const stale of manifest.grace.staleRefs) {
    if (existsSync(join(repoRoot, stale))) fail("grace.staleRefs still lists " + stale + ", which now exists; drop the grace entry");
  }
  for (const absent of manifest.absentPaths) {
    if (existsSync(join(repoRoot, absent.path))) {
      fail(
        absent.path + " is declared absent in manifest.json but now exists; the docs that describe its absence are wrong",
      );
    }
  }

  // 4. decision records
  const adrFiles = present.filter((p) => p.startsWith("decisions/"));
  const referenced = new Map<string, string[]>();
  for (const doc of manifest.docs) {
    const abs = join(structureDir, doc.path);
    if (!existsSync(abs)) continue;
    const body = readFileSync(abs, "utf8");
    for (const m of body.match(/decisions\/ADR-[0-9]{4}-[a-z0-9-]*\.md/g) ?? []) {
      const key = "decisions/" + m.split("/")[1];
      referenced.set(key, [...(referenced.get(key) ?? []), doc.path]);
    }
  }
  const ids = new Set<number>();
  for (const adr of adrFiles) {
    const name = adr.slice("decisions/".length);
    const match = /^ADR-([0-9]{4})-[a-z0-9-]+\.md$/.exec(name);
    if (!match) {
      fail("structure/" + adr + " does not match ADR-NNNN-slug.md");
      continue;
    }
    const n = Number(match[1]);
    if (ids.has(n)) fail("decision record number " + match[1] + " is used twice");
    ids.add(n);
    const owners = referenced.get(adr) ?? [];
    if (owners.length === 0) fail("structure/" + adr + " is not linked from any doc; every record needs a contract owner");
    if (owners.length > 1) fail("structure/" + adr + " is linked from " + owners.join(", ") + "; a record has one owner");
  }
  for (const key of referenced.keys()) {
    if (!adrFiles.includes(key)) fail("a doc links structure/" + key + ", which does not exist");
  }
  const sorted = [...ids].sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    if (n !== i + 1) fail("decision record numbering has a hole or offset at ADR-" + String(n).padStart(4, "0"));
  });

  // 5. invariant-to-test bindings
  const overviewPath = join(structureDir, "overview.md");
  if (existsSync(overviewPath)) {
    const body = readFileSync(overviewPath, "utf8");
    const invRe = new RegExp("\\*\\*(INV-[A-Z0-9-]+)\\*\\*", "g");
    const enforcedRe = new RegExp("\\*\\*(INV-[A-Z0-9-]+)\\*\\*[\\s\\S]*?Enforced by " + BT + "([^" + BT + "]+)" + BT, "g");
    const declaredIds = (body.match(invRe) ?? []).map((s) => s.replace(/\*/g, ""));
    const seen = new Set<string>();
    for (const id of declaredIds) {
      if (seen.has(id)) fail("overview.md declares " + id + " twice");
      seen.add(id);
    }
    const bound = new Map<string, string>();
    let m: RegExpExecArray | null;
    enforcedRe.lastIndex = 0;
    while ((m = enforcedRe.exec(body))) if (!bound.has(m[1])) bound.set(m[1], m[2]);
    if (declaredIds.length === 0) fail("overview.md declares no invariants; the invariant index cannot be empty");
    for (const id of declaredIds) {
      const test = bound.get(id);
      if (!test) {
        fail(id + " has no " + BT + "Enforced by" + BT + " test binding in overview.md");
        continue;
      }
      const abs = join(repoRoot, test);
      if (!existsSync(abs)) {
        fail(id + " names " + test + ", which does not exist");
        continue;
      }
      if (!readFileSync(abs, "utf8").includes(id)) {
        fail(test + " does not name " + id + "; the binding has to be readable from the test side too");
      }
    }
  }

  // 6. source ownership
  const claims = new Map<string, string>();
  for (const doc of manifest.docs) {
    for (const own of doc.owns) {
      if (claims.has(own)) fail(own + " is claimed by both " + claims.get(own) + " and " + doc.path);
      claims.set(own, doc.path);
      if (!existsSync(join(repoRoot, own))) fail("structure/" + doc.path + " claims " + own + ", which does not exist");
    }
  }
  const graced = new Set(manifest.grace.unownedSourceAreas.map((g) => g.path));
  for (const g of graced) {
    if (!existsSync(join(repoRoot, g))) fail("grace.unownedSourceAreas lists " + g + ", which does not exist");
    if (claims.has(g)) fail(g + " is both owned and listed as unowned");
  }
  const srcDir = join(repoRoot, "src");
  if (existsSync(srcDir)) {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const area = "src/" + entry.name + "/";
      const covered = [...claims.keys()].some((c) => c === area || c.startsWith(area)) || graced.has(area);
      if (!covered) {
        fail(
          area + " has no owning doc; add it to a doc's " + BT + "owns" + BT +
            " list or record it in grace.unownedSourceAreas with a reason",
        );
      }
    }
  }

  // 7. generated index parity
  const indexPath = join(structureDir, "INDEX.md");
  const expected = renderIndex(manifest);
  if (!existsSync(indexPath)) fail("structure/INDEX.md is missing; run bun run structure:index");
  else if (readFileSync(indexPath, "utf8").replace(/\r\n/g, "\n") !== expected) {
    fail("structure/INDEX.md drifted from manifest.json; run bun run structure:index");
  }

  return failures;
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const fix = process.argv.includes("--fix");
  if (fix) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "structure/manifest.json"), "utf8")) as Manifest;
    writeFileSync(join(repoRoot, "structure/INDEX.md"), renderIndex(manifest), "utf8");
    console.log("wrote structure/INDEX.md");
  }
  const failures = runStructureChecks(repoRoot);
  if (failures.length === 0) {
    console.log("structure/ SSOT checks passed");
    process.exit(0);
  }
  for (const f of failures) console.error("  - " + f);
  console.error(failures.length + " structure/ SSOT failure(s)");
  process.exit(1);
}
