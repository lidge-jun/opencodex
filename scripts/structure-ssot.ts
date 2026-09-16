#!/usr/bin/env bun
/**
 * structure/ single-source-of-truth gate.
 *
 * The maintainer docs under structure/ are a SECOND description of this tree, and a second
 * description drifts. This module is the proof that it has not: it validates the doc map, the
 * source-to-doc map, decision-record topology, invariant-to-test bindings, and every link, anchor
 * and repository path the docs name. It also generates structure/INDEX.md, so the reading order
 * cannot contradict the manifest.
 *
 * Two deliberate choices, both learned from an earlier revision of this file that got them wrong:
 *
 * - Paths are checked against the GIT INDEX first, not the filesystem. existsSync cannot tell a
 *   tracked file from untracked local leftovers, and it is case-insensitive on Windows and
 *   case-sensitive on Linux, so a filesystem-only gate gives a different verdict per machine and
 *   fails a maintainer who still has a retired directory on disk.
 * - A source area may be described by MORE THAN ONE doc. An earlier design demanded exactly one
 *   owner per area; in this repository that claim was simply false (src/server/ is described by the
 *   management-API doc, the Responses transport doc and the Images doc), and a rule that is false
 *   is worse than no rule because the gate reports green while the map misdirects.
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
  docs: { path: string; tier: number; title: string; scope: string; documents: string[] }[];
  grace: {
    undocumentedSourceAreas: { path: string; reason: string }[];
    unboundInvariants: { id: string; reason: string }[];
    oversizeDocs: string[];
    staleRefs: string[];
  };
};

const GENERATED_DOCS = ["INDEX.md"];
const RULE_DOCS = ["AGENTS.md"];
/**
 * Roots that stay checked even after they are deleted. Deriving the root set from the tree alone
 * means a reference becomes INVISIBLE exactly when the directory disappears, which is the moment
 * stale references start appearing. go/ is the live example: it is retired and untracked, and
 * without this list every remaining go/ mention would go unchecked.
 */
const HISTORICAL_ROOTS = ["src", "tests", "gui", "scripts", "docs", "docs-site", "bin", "go", "devlog", ".github", "structure", "readme"];

const toPosix = (p: string) => p.split("\\").join("/");
const trimSlash = (p: string) => p.replace(/\/+$/, "");

/** Parse and validate the manifest, so a malformed file is an actionable failure, not a stack trace. */
export function loadManifest(raw: string): { manifest: Manifest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { error: "structure/manifest.json is not valid JSON: " + (cause as Error).message };
  }
  const m = parsed as Partial<Manifest>;
  const problems: string[] = [];
  const isArray = (v: unknown) => Array.isArray(v);
  if (typeof m.sizeBudgetLines !== "number") problems.push("sizeBudgetLines must be a number");
  if (!isArray(m.generatedPaths)) problems.push("generatedPaths must be an array");
  if (!isArray(m.absentPaths)) problems.push("absentPaths must be an array");
  else {
    m.absentPaths.forEach((entry, i) => {
      if (typeof entry?.path !== "string") problems.push("absentPaths[" + i + "].path must be a string");
      if (typeof entry?.reason !== "string") problems.push("absentPaths[" + i + "].reason must be a string");
    });
  }
  if (!isArray(m.tiers)) problems.push("tiers must be an array");
  if (!isArray(m.docs)) problems.push("docs must be an array");
  else {
    m.docs.forEach((doc, i) => {
      if (typeof doc?.path !== "string") problems.push("docs[" + i + "].path must be a string");
      if (typeof doc?.tier !== "number") problems.push("docs[" + i + "].tier must be a number");
      if (typeof doc?.title !== "string") problems.push("docs[" + i + "].title must be a string");
      if (typeof doc?.scope !== "string") problems.push("docs[" + i + "].scope must be a string");
      if (!isArray(doc?.documents)) problems.push("docs[" + i + "].documents must be an array");
    });
  }
  const grace = m.grace as Partial<Manifest["grace"]> | undefined;
  if (!grace) problems.push("grace must be an object");
  else {
    for (const key of ["undocumentedSourceAreas", "unboundInvariants", "oversizeDocs", "staleRefs"] as const) {
      if (!isArray(grace[key])) problems.push("grace." + key + " must be an array");
    }
    if (isArray(grace.undocumentedSourceAreas)) {
      grace.undocumentedSourceAreas.forEach((entry, i) => {
        if (typeof entry?.path !== "string") problems.push("grace.undocumentedSourceAreas[" + i + "].path must be a string");
        if (typeof entry?.reason !== "string") problems.push("grace.undocumentedSourceAreas[" + i + "].reason must be a string");
      });
    }
    if (isArray(grace.unboundInvariants)) {
      grace.unboundInvariants.forEach((entry, i) => {
        if (typeof entry?.id !== "string") problems.push("grace.unboundInvariants[" + i + "].id must be a string");
        if (typeof entry?.reason !== "string") problems.push("grace.unboundInvariants[" + i + "].reason must be a string");
      });
    }
    for (const key of ["oversizeDocs", "staleRefs"] as const) {
      if (!isArray(grace[key])) continue;
      grace[key].forEach((entry, i) => {
        if (typeof entry !== "string") problems.push("grace." + key + "[" + i + "] must be a string");
      });
    }
  }
  if (problems.length > 0) return { error: "structure/manifest.json is malformed: " + problems.join("; ") };
  return { manifest: parsed as Manifest };
}

function listMarkdown(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, root, out);
    else if (entry.name.endsWith(".md")) out.push(toPosix(relative(root, full)));
  }
  return out.sort();
}

/** Tracked files plus every directory on their way up, read once from the git index. */
function trackedPaths(repoRoot: string): Set<string> | null {
  let stdout: string;
  try {
    const run = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) return null;
    stdout = new TextDecoder().decode(run.stdout);
  } catch {
    return null;
  }
  const set = new Set<string>();
  for (const file of stdout.split("\0")) {
    if (!file) continue;
    set.add(file);
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) set.add(parts.slice(0, i).join("/"));
  }
  return set.size > 0 ? set : null;
}

/** Markdown body with fenced blocks blanked out, so examples inside a fence are not scanned. */
function withoutFences(body: string): string {
  let fenced = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(?:\u0060\u0060\u0060|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line;
    })
    .join("\n");
}

/** GitHub-style heading anchor. */
function headingAnchors(body: string): Set<string> {
  const out = new Set<string>();
  for (const line of withoutFences(body).split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .replace(/\u0060/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/\s+/g, "-");
    if (slug) out.add(slug);
  }
  return out;
}

export function renderIndex(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push("# opencodex Structure Index");
  lines.push("");
  lines.push("This folder is the maintainer source of truth for the current system shape. Public user workflows");
  lines.push("belong in " + BT + "docs-site/" + BT + ". Development work is recorded in " + BT + "devlog/" + BT + " units — " + BT + "_plan/" + BT + " while open,");
  lines.push(BT + "_fin/" + BT + " once closed — while " + BT + "docs/" + BT + " keeps investigations and diagnostic notes worth retaining for");
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
    for (const doc of docs) lines.push("| [" + BT + doc.path + BT + "](" + doc.path + ") | " + doc.scope + " |");
  }
  lines.push("");
  lines.push("## Which doc describes which source");
  lines.push("");
  lines.push("A source area can be described by more than one doc, because these docs are organised by topic and");
  lines.push(BT + "src/" + BT + " is organised by module. Changing an area obliges the same change to update every doc listed");
  lines.push("for it; see [" + BT + "AGENTS.md" + BT + "](AGENTS.md).");
  lines.push("");
  lines.push("| Source path | Described by |");
  lines.push("| --- | --- |");
  const byPath = new Map<string, string[]>();
  for (const doc of manifest.docs) {
    for (const area of doc.documents) byPath.set(area, [...(byPath.get(area) ?? []), doc.path]);
  }
  for (const area of [...byPath.keys()].sort()) {
    const docs = byPath.get(area)!.map((d) => "[" + BT + d + BT + "](" + d + ")").join("<br>");
    lines.push("| " + BT + area + BT + " | " + docs + " |");
  }
  lines.push("");
  lines.push("### Not described by any doc");
  lines.push("");
  lines.push("| Source path | Why |");
  lines.push("| --- | --- |");
  for (const row of [...manifest.grace.undocumentedSourceAreas].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push("| " + BT + row.path + BT + " | " + row.reason + " |");
  }
  lines.push("");
  lines.push("## Decision records");
  lines.push("");
  lines.push("Superseded reasoning lives in " + BT + "decisions/" + BT + " as numbered records. A doc states the contract that holds now and");
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
  const loaded = loadManifest(readFileSync(manifestPath, "utf8"));
  if ("error" in loaded) return [loaded.error];
  const manifest = loaded.manifest;

  const tracked = trackedPaths(repoRoot);
  const trackedLower = new Map<string, string>();
  if (tracked) for (const p of tracked) trackedLower.set(p.toLowerCase(), p);

  /**
   * A repository path is real when git tracks it. The filesystem is consulted only when the index
   * could not be read at all: CI checks out a clean tree, so an untracked local leftover that
   * satisfied the gate here would still fail there, which is the split verdict this module exists
   * to remove. The cost is that a newly written file has to be staged before the gate can see it.
   */
  const pathIsReal = (raw: string): "ok" | "missing" | string => {
    const p = trimSlash(raw);
    if (!tracked) return existsSync(join(repoRoot, p)) ? "ok" : "missing";
    if (tracked.has(p)) return "ok";
    const variant = trackedLower.get(p.toLowerCase());
    if (variant && variant !== p) return variant;
    return "missing";
  };
  const isTracked = (raw: string) => tracked?.has(trimSlash(raw)) ?? existsSync(join(repoRoot, trimSlash(raw)));
  // Top-level entries, so a backticked root FILE is validated directly, the same as a directory
  // path. The historical roots are unioned in so a deleted tree keeps being checked.
  const rootEntries = new Set<string>(HISTORICAL_ROOTS);
  if (tracked) for (const p of tracked) rootEntries.add(p.split("/")[0]!);
  else for (const entry of readdirSync(repoRoot, { withFileTypes: true })) rootEntries.add(entry.name);

  const present = listMarkdown(structureDir, structureDir);
  const sotOnDisk = present.filter((p) => !p.startsWith("decisions/") && !GENERATED_DOCS.includes(p) && !RULE_DOCS.includes(p));
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
    // Leading digits are rejected outright: 09_x.md and 01-x.md are the same mistake.
    if (!/^(?:[a-z][a-z0-9-]*\/)?[a-z][a-z0-9-]*\.md$/.test(doc.path)) {
      fail("structure/" + doc.path + " must be kebab-case, start with a letter, and sit at most one directory deep");
    }
  }

  // 2. size budget
  for (const doc of manifest.docs) {
    const p = join(structureDir, doc.path);
    if (!existsSync(p)) continue;
    const count = readFileSync(p, "utf8").replace(/\n$/, "").split("\n").length;
    const graced = manifest.grace.oversizeDocs.includes(doc.path);
    if (count > manifest.sizeBudgetLines && !graced) {
      fail("structure/" + doc.path + " is " + count + " lines, over the " + manifest.sizeBudgetLines + "-line budget; split it or add it to grace.oversizeDocs with a plan");
    }
    if (count <= manifest.sizeBudgetLines && graced) {
      fail("grace.oversizeDocs still lists structure/" + doc.path + ", which is now " + count + " lines; drop the grace entry");
    }
  }
  for (const p of manifest.grace.oversizeDocs) {
    if (!declared.includes(p)) fail("grace.oversizeDocs names structure/" + p + ", which is not a declared doc");
  }

  // 3. links, anchors, repository paths, and the inline-decision ban
  const linkRe = /\]\(([^)\s]+)\)/g;
  const pathRe = new RegExp(BT + "([A-Za-z0-9_.@-]+(?:/[A-Za-z0-9_.@-]*)*)" + BT, "g");
  const anchorCache = new Map<string, Set<string>>();
  for (const rel of present) {
    const abs = join(structureDir, rel);
    const raw = readFileSync(abs, "utf8");
    const body = withoutFences(raw);
    const isRecord = rel.startsWith("decisions/");
    for (const line of body.split("\n")) {
      if (/\[decision log\]/i.test(line) || /^-\s*목적과 의도\s*:/.test(line.trim())) {
        if (!isRecord) fail("structure/" + rel + " carries inline decision-log reasoning; move it to decisions/ and link the record");
      }
    }
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(body))) {
      const target = m[1];
      if (/^(?:https?|mailto):/.test(target)) continue;
      const [file, fragment] = target.split("#");
      // A fragment-only link points at this same document; it still has to name a real heading.
      const resolved = file === "" ? abs : resolve(dirname(abs), file);
      if (file !== "") {
        const repoRel = toPosix(relative(repoRoot, resolved));
        const verdict = pathIsReal(repoRel);
        if (verdict === "missing") {
          fail("structure/" + rel + " links " + target + ", which does not exist");
          continue;
        }
        if (verdict !== "ok") {
          fail("structure/" + rel + " links " + target + ", but the tracked path is " + verdict);
          continue;
        }
      }
      if (fragment && resolved.endsWith(".md")) {
        if (!anchorCache.has(resolved)) anchorCache.set(resolved, headingAnchors(readFileSync(resolved, "utf8")));
        if (!anchorCache.get(resolved)!.has(fragment)) {
          fail("structure/" + rel + " links " + target + ", but that heading anchor does not exist");
        }
      }
    }
    // A decision record describes a PAST state, so its prose is not held against the present tree.
    if (isRecord) continue;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(body))) {
      const named = trimSlash(m[1]);
      // Only tokens rooted at a real top-level entry are paths; the rest are ordinary code spans.
      if (!rootEntries.has(named.split("/")[0]!)) continue;
      if (manifest.generatedPaths.some((g) => named === trimSlash(g) || named.startsWith(trimSlash(g) + "/"))) continue;
      if (manifest.absentPaths.some((a) => trimSlash(a.path) === named)) continue;
      if (manifest.grace.staleRefs.map(trimSlash).includes(named)) continue;
      const verdict = pathIsReal(named);
      if (verdict === "missing") fail("structure/" + rel + " names " + named + ", which this tree does not have");
      else if (verdict !== "ok") fail("structure/" + rel + " names " + named + ", but the tracked path is " + verdict);
    }
  }
  for (const stale of manifest.grace.staleRefs) {
    if (pathIsReal(stale) === "ok") fail("grace.staleRefs still lists " + stale + ", which now exists; drop the grace entry");
  }
  for (const absent of manifest.absentPaths) {
    if (isTracked(absent.path)) fail(absent.path + " is declared absent in manifest.json but is tracked; the docs describing its absence are wrong");
  }

  // 4. decision records
  const adrFiles = present.filter((p) => p.startsWith("decisions/"));
  const referenced = new Map<string, Set<string>>();
  // Ownership is the declared link form, read with fences removed. A record path mentioned in prose
  // or shown inside an example is not a claim of ownership, and counting it made an orphaned record
  // look owned while reporting a second owner nobody could remove.
  const ownerLinkRe = /^>\s*Decision record:\s*\[[^\]]*\]\(([^)\s]+)\)/gm;
  for (const doc of manifest.docs) {
    const abs = join(structureDir, doc.path);
    if (!existsSync(abs)) continue;
    const body = withoutFences(readFileSync(abs, "utf8"));
    ownerLinkRe.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = ownerLinkRe.exec(body))) {
      const target = hit[1].split("#")[0]!;
      const repoRel = toPosix(relative(structureDir, resolve(dirname(abs), target)));
      // The link has to land in decisions/; a basename match would let a record elsewhere claim
      // ownership of a file it does not point at.
      if (!repoRel.startsWith("decisions/")) {
        fail("structure/" + doc.path + " points a Decision record line at " + target + ", which is not in decisions/");
        continue;
      }
      referenced.set(repoRel, (referenced.get(repoRel) ?? new Set<string>()).add(doc.path));
    }
  }
  const ids = new Set<string>();
  for (const adr of adrFiles) {
    const name = adr.slice("decisions/".length);
    const match = /^ADR-([0-9]{4})-[a-z0-9-]+\.md$/.exec(name);
    if (!match) {
      fail("structure/" + adr + " does not match ADR-NNNN-slug.md");
      continue;
    }
    if (ids.has(match[1])) fail("decision record number " + match[1] + " is used twice");
    ids.add(match[1]);
    const owners = [...(referenced.get(adr) ?? new Set<string>())];
    if (owners.length === 0) fail("structure/" + adr + " is not linked from any doc; every record needs a contract owner");
    if (owners.length > 1) fail("structure/" + adr + " is linked from " + owners.join(" and ") + "; a record has one owner");
  }
  for (const key of referenced.keys()) if (!adrFiles.includes(key)) fail("a doc links structure/" + key + ", which does not exist");

  // 5. invariant-to-test bindings
  const overviewPath = join(structureDir, "overview.md");
  if (!existsSync(overviewPath)) {
    fail("structure/overview.md is missing; it is the invariant index, and its absence would silence every binding check");
  } else {
    const body = readFileSync(overviewPath, "utf8");
    const blocks: { id: string; text: string }[] = [];
    let current: { id: string; text: string } | null = null;
    for (const line of body.split("\n")) {
      const start = /^-\s+\*\*(INV-[A-Z0-9-]+)\*\*/.exec(line);
      if (start) {
        if (current) blocks.push(current);
        current = { id: start[1], text: line };
      } else if (/^-\s/.test(line)) {
        if (current) blocks.push(current);
        current = null;
      } else if (current) current.text += "\n" + line;
    }
    if (current) blocks.push(current);
    if (blocks.length === 0) fail("overview.md declares no invariants; the invariant index cannot be empty");
    const seen = new Set<string>();
    const unbound = new Map(manifest.grace.unboundInvariants.map((u) => [u.id, u.reason]));
    for (const block of blocks) {
      if (seen.has(block.id)) fail("overview.md declares " + block.id + " twice");
      seen.add(block.id);
      const bound = new RegExp("Enforced by " + BT + "([^" + BT + "]+)" + BT).exec(block.text);
      if (!bound) {
        if (!unbound.has(block.id)) {
          fail(block.id + " has no Enforced by binding and is not recorded in grace.unboundInvariants with a reason");
        }
        continue;
      }
      if (unbound.has(block.id)) {
        fail(block.id + " is bound to a test and also listed in grace.unboundInvariants; drop the grace entry");
        continue;
      }
      const test = bound[1];
      if (!/^tests\/.+\.test\.ts$/.test(test)) {
        fail(block.id + " names " + test + ", which is not a tests/**.test.ts file");
        continue;
      }
      if (pathIsReal(test) !== "ok") {
        fail(block.id + " names " + test + ", which this tree does not have");
        continue;
      }
      const source = readFileSync(join(repoRoot, test), "utf8");
      if (!new RegExp(block.id + "(?![A-Z0-9-])").test(source)) {
        fail(test + " does not name " + block.id + "; the binding has to be readable from the test side too");
      }
    }
    for (const id of unbound.keys()) {
      if (!seen.has(id)) fail("grace.unboundInvariants names " + id + ", which overview.md does not declare");
    }
  }

  // 6. source-to-doc map
  const described = new Map<string, string[]>();
  // What a doc actually names, so a manifest claim cannot invent coverage the prose does not have.
  const namedByDoc = new Map<string, string[]>();
  for (const doc of manifest.docs) {
    const abs = join(structureDir, doc.path);
    if (!existsSync(abs)) continue;
    const body = withoutFences(readFileSync(abs, "utf8"));
    const found: string[] = [];
    const re = new RegExp(pathRe.source, "g");
    let hit: RegExpExecArray | null;
    while ((hit = re.exec(body))) found.push(hit[1]);
    namedByDoc.set(doc.path, found);
  }
  for (const doc of manifest.docs) {
    const own = new Set<string>();
    for (const area of doc.documents) {
      if (own.has(area)) fail("structure/" + doc.path + " lists " + area + " twice");
      own.add(area);
      described.set(area, [...(described.get(area) ?? []), doc.path]);
      const verdict = pathIsReal(area);
      if (verdict === "missing") fail("structure/" + doc.path + " claims " + area + ", which this tree does not have");
      else if (verdict !== "ok") fail("structure/" + doc.path + " claims " + area + ", but the tracked path is " + verdict);
      const names = namedByDoc.get(doc.path) ?? [];
      if (!names.some((n) => n === area || n === trimSlash(area) || n.startsWith(area))) {
        fail("structure/" + doc.path + " claims " + area + " but never names it or a path in it");
      }
    }
  }
  const graced = new Map(manifest.grace.undocumentedSourceAreas.map((g) => [g.path, g.reason]));
  for (const g of graced.keys()) {
    if (pathIsReal(g) !== "ok") fail("grace.undocumentedSourceAreas lists " + g + ", which this tree does not have");
    if (described.has(g)) fail(g + " is both described and listed as undescribed");
  }
  // Enumerated from the index when it is readable, for the same reason paths are resolved there:
  // an untracked scratch directory under src/ must not produce a failure CI cannot reproduce.
  const srcAreas = new Set<string>();
  if (tracked) {
    for (const p of tracked) {
      if (!p.startsWith("src/")) continue;
      const rest = p.slice("src/".length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (rest.endsWith(".ts")) srcAreas.add("src/" + rest);
      } else srcAreas.add("src/" + rest.slice(0, slash) + "/");
    }
  } else if (existsSync(join(repoRoot, "src"))) {
    for (const entry of readdirSync(join(repoRoot, "src"), { withFileTypes: true })) {
      if (entry.isDirectory()) srcAreas.add("src/" + entry.name + "/");
      else if (entry.name.endsWith(".ts")) srcAreas.add("src/" + entry.name);
    }
  }
  for (const area of [...srcAreas].sort()) {
    // A claim on one file inside a directory does not cover the directory.
    if (described.has(area) || graced.has(area)) continue;
    fail(area + " is described by no doc; add it to a doc's " + BT + "documents" + BT + " list or record it in grace.undocumentedSourceAreas with a reason");
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
  if (process.argv.includes("--fix")) {
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
