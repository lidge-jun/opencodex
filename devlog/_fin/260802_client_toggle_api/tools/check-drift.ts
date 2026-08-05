/**
 * Cross-document contract drift checker.
 *
 * `check-blocks.ts` compiles each fenced block in isolation, which catches
 * syntax and same-block type errors but is blind by construction to the defect
 * that actually kept recurring: a canonical declaration in `006` and a
 * consumer in another document disagreeing. Isolated compilation cannot see
 * that, and suppressing whole diagnostic codes to silence `noResolve` noise
 * threw away the very errors that would have shown it.
 *
 * This pass is deliberately not a type checker. It compares DECLARED SHAPES
 * across documents by text: the canonical declaration of a named type wins,
 * and any other declaration of the same name must match it field-for-field.
 * It also enforces the module-ownership rules that no compiler can infer from
 * markdown, and scans `diff` fences, which the block checker skips entirely.
 *
 * Usage: bun devlog/_plan/260802_client_toggle_api/tools/check-drift.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Finding { file: string; line: number; rule: string; detail: string }

/** Types whose canonical declaration lives in 006 and may not be redeclared differently. */
const CANONICAL_DOC = "006_module_contracts.md";
const CANONICAL_TYPES = [
  "JournalEntry", "SnapshotRef", "OwnershipRecord", "WriteRefused", "WriteOk",
  "IntegrationIO", "IntegrationWriteInput", "IntegrationRestoreInput",
  "IntegrationJournalRow", "ManagedContribution", "ManagedFragment",
];

/**
 * Module ownership: a symbol may be DECLARED in exactly one module. Encoded
 * because `006 §8` states it in prose and prose does not fail a build.
 */
const OWNERSHIP: Record<string, string> = {
  parseConfig: "config-io.ts",
  loadTarget: "config-io.ts",
  defaultIntegrationIO: "config-io.ts",
  /*
   * A shared SENTINEL is the sharpest case: two `Symbol("parse-failed")`
   * calls are different values, so a second declaration does not merely
   * duplicate code — it silently breaks every comparison against it, and an
   * unparseable config gets classified `absent` and overwritten
   * (A-gate round 10, blocker 1).
   */
  PARSE_FAILED: "config-io.ts",
};

/** Owned symbols that other modules import, so the declaration must be exported. */
const MUST_EXPORT = new Set(["parseConfig", "loadTarget", "defaultIntegrationIO", "PARSE_FAILED"]);

/**
 * Cross-phase fields that must appear in every layer's copy of a shape.
 * A field the backend produces and the GUI never declares is a contract that
 * exists only in prose, which is how `retentionDegraded` nearly shipped as an
 * invention task for two later phases.
 */
const PROPAGATED: { field: string; shape: string; docs: string[] }[] = [
  { field: "retentionDegraded", shape: "IntegrationStatus",
    docs: ["020_wp2_ownership_core.md", "021_wp2_journal_impl.md", "060_wp6_gui_surfaces.md"] },
  { field: "snapshotCount", shape: "IntegrationStatus",
    docs: ["020_wp2_ownership_core.md", "021_wp2_journal_impl.md", "060_wp6_gui_surfaces.md"] },
  { field: "priorRecord", shape: "JournalEntry",
    docs: ["006_module_contracts.md", "020_wp2_ownership_core.md", "021_wp2_journal_impl.md"] },
];

function docs(dir: string): string[] {
  return readdirSync(dir).filter(n => /^\d{3}.*\.md$/.test(n)).sort();
}

/** Collect `export interface X { ... }` bodies, keyed by name, with location. */
function interfaceBodies(text: string, file: string): Map<string, { body: string; line: number }[]> {
  const found = new Map<string, { body: string; line: number }[]>();
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const match = /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)\s*(?:extends\s+[A-Za-z0-9_]+\s*)?\{/.exec(line);
    if (!match) continue;
    let depth = 0;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const current = lines[j]!;
      depth += (current.match(/\{/g) ?? []).length - (current.match(/\}/g) ?? []).length;
      if (j > i) body.push(current);
      if (depth <= 0 && j > i) break;
    }
    const list = found.get(match[1]!) ?? [];
    list.push({ body: body.join("\n"), line: i + 1 });
    found.set(match[1]!, list);
  }
  return found;
}

/**
 * Compare types by meaning, not by spelling. `SnapshotRef["kind"]` and the
 * union it indexes are the same contract; so are `OperationKind` and its
 * definition. Without this the checker reports style, and a checker that cries
 * about style gets ignored — which is how a real drift would slip past.
 */
const TYPE_SYNONYMS: [RegExp, string][] = [
  [/^SnapshotRef\["kind"\]$/, '"none" | "stored" | "expired"'],
  [/^OperationKind$/, '"apply" | "disable" | "refresh" | "restore"'],
];

function normalizeType(text: string): string {
  const collapsed = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .replace(/^\|\s*/, "")
    .trim();
  for (const [pattern, canonical] of TYPE_SYNONYMS) {
    if (pattern.test(collapsed)) return canonical;
  }
  return collapsed;
}

/** Field names declared in an interface body, ignoring comments and optionality. */
function fieldNames(body: string): Set<string> {
  return new Set(fieldSignatures(body).keys());
}

/**
 * `name -> "?:type"`, normalized. Comparing names alone let `priorRecord:
 * string` or `retentionDegraded?: boolean` pass as matching the canonical
 * shape (A-gate round 8, blocker 2), so optionality and the declared type are
 * part of the signature now.
 */
function fieldSignatures(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
    const match = /^(readonly\s+)?([A-Za-z0-9_]+)(\??)\s*:\s*(.+?);?\s*(\/\/.*)?$/.exec(line);
    if (!match) continue;
    fields.set(match[2]!, `${match[1] ? "readonly " : ""}${match[3]}:${normalizeType(match[4]!)}`);
  }
  return fields;
}

/** `export type X = ...` bodies, so union aliases are compared too. */
function typeAliases(text: string): Map<string, { body: string; line: number }> {
  const found = new Map<string, { body: string; line: number }>();
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const match = /^\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const parts: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const raw = j === i ? match[2]! : lines[j]!;
      // Stop before a new top-level declaration: a union written without a
      // terminator would otherwise swallow whatever follows it, which made two
      // identical SnapshotRef declarations compare as different.
      if (j > i && /^\s*(export|interface|type|function|const|\/\*\*)/.test(raw)) break;
      parts.push(raw.replace(/\/\/.*$/, "").trimEnd());
      // Detect the terminator on the RAW line: a trailing comment moves the
      // semicolon off the end of the stripped code.
      if (/;\s*(\/\/.*)?$/.test(raw)) break;
      if (j > i && raw.trim().length === 0) break;
    }
    found.set(match[1]!, { body: normalizeType(parts.join(" ")), line: i + 1 });
  }
  return found;
}

function main(): void {
  const unitDir = dirname(dirname(import.meta.path));
  const files = docs(unitDir);
  const findings: Finding[] = [];

  // 1. Canonical shapes.
  const canonical = interfaceBodies(readFileSync(join(unitDir, CANONICAL_DOC), "utf8"), CANONICAL_DOC);
  for (const file of files) {
    if (file === CANONICAL_DOC) continue;
    const here = interfaceBodies(readFileSync(join(unitDir, file), "utf8"), file);
    for (const name of CANONICAL_TYPES) {
      const truth = canonical.get(name)?.[0];
      const copies = here.get(name);
      if (!truth || !copies) continue;
      const expected = fieldNames(truth.body);
      for (const copy of copies) {
        const truthSig = fieldSignatures(truth.body);
        const actualSig = fieldSignatures(copy.body);
        const actual = new Set(actualSig.keys());
        const missing = [...expected].filter(f => !actual.has(f));
        const extra = [...actual].filter(f => !expected.has(f));
        const changed = [...truthSig.entries()]
          .filter(([name, sig]) => actualSig.has(name) && actualSig.get(name) !== sig)
          .map(([name, sig]) => `${name} (${CANONICAL_DOC}: ${sig}, here: ${actualSig.get(name)})`);
        if (missing.length || extra.length || changed.length) {
          findings.push({
            file, line: copy.line, rule: "canonical-shape",
            detail: `${name} disagrees with ${CANONICAL_DOC}` +
              (missing.length ? ` — missing: ${missing.join(", ")}` : "") +
              (extra.length ? ` — unexpected: ${extra.join(", ")}` : "") +
              (changed.length ? ` — changed: ${changed.join("; ")}` : ""),
          });
        }
      }
    }
    // Union aliases (SnapshotRef, RefusalReason) were not compared at all.
    const canonicalAliases = typeAliases(readFileSync(join(unitDir, CANONICAL_DOC), "utf8"));
    const hereAliases = typeAliases(readFileSync(join(unitDir, file), "utf8"));
    for (const name of CANONICAL_TYPES) {
      const truth = canonicalAliases.get(name);
      const copy = hereAliases.get(name);
      if (!truth || !copy || truth.body === copy.body) continue;
      findings.push({ file, line: copy.line, rule: "canonical-shape",
        detail: `type ${name} differs from ${CANONICAL_DOC}: "${copy.body}" vs "${truth.body}"` });
    }
  }

  /*
   * 2. Module ownership. The earlier version only rejected EXPORTED
   * declarations outside a `021_wp2*` doc, so a non-exported copy passed and a
   * missing owner was indistinguishable from a satisfied one (A-gate round 9,
   * blocker 1). It now counts declarations of any visibility and requires
   * exactly one, inside the block that declares the owning module.
   */
  const declarationSites = new Map<string, { file: string; line: number }[]>();
  for (const file of files) {
    const text = readFileSync(join(unitDir, file), "utf8");
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      for (const [symbol, owner] of Object.entries(OWNERSHIP)) {
        // Any visibility, and `const x = (` forms too.
        const declares =
          new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`).test(line)
          || new RegExp(`^\\s*(?:export\\s+)?const\\s+${symbol}\\s*[:=]`).test(line);
        if (declares) {
          const sites = declarationSites.get(symbol) ?? [];
          sites.push({ file, line: i + 1 });
          declarationSites.set(symbol, sites);
          if (MUST_EXPORT.has(symbol) && !/^\s*export\s/.test(line)) {
            findings.push({ file, line: i + 1, rule: "ownership",
              detail: `${symbol} is imported by other modules but declared without \`export\`` });
          }
        }
        const importMatch = new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*"([^"]+)"`).exec(line);
        if (importMatch && !importMatch[1]!.endsWith("config-io")) {
          findings.push({ file, line: i + 1, rule: "ownership",
            detail: `${symbol} imported from ${importMatch[1]} but is owned by ${owner}` });
        }
      }
    }
  }
  for (const [symbol, owner] of Object.entries(OWNERSHIP)) {
    const sites = declarationSites.get(symbol) ?? [];
    if (sites.length === 0) {
      findings.push({ file: owner, line: 1, rule: "ownership",
        detail: `${symbol} is owned by ${owner} but is declared nowhere — WP2 cannot implement it` });
      continue;
    }
    if (sites.length > 1) {
      for (const site of sites.slice(1)) {
        findings.push({ file: site.file, line: site.line, rule: "ownership",
          detail: `${symbol} is declared ${sites.length} times; ${owner} must be the only one (first at ${sites[0]!.file}:${sites[0]!.line})` });
      }
    }
    const home = sites[0]!;
    const inOwnerModule = new RegExp(`\`src/integrations/${owner.replace(".", "\\.")}\``).test(
      readFileSync(join(unitDir, home.file), "utf8").split("\n").slice(0, home.line).join("\n"),
    );
    if (!inOwnerModule) {
      findings.push({ file: home.file, line: home.line, rule: "ownership",
        detail: `${symbol} is declared here, but this location is not introduced as ${owner}` });
    }
  }

  // 3. Reason-first HTTP mapping (006 §5): no branch may test `state` first.
  for (const { field, shape, docs: required } of PROPAGATED) {
    for (const file of required) {
      const bodies = interfaceBodies(readFileSync(join(unitDir, file), "utf8"), file).get(shape);
      if (!bodies || bodies.length === 0) {
        findings.push({ file, line: 1, rule: "propagation",
          detail: `${shape} is not declared here, but ${field} must propagate through it` });
        continue;
      }
      if (!bodies.some(b => fieldNames(b.body).has(field))) {
        findings.push({ file, line: bodies[0]!.line, rule: "propagation",
          detail: `${shape} is missing ${field} — the contract exists in 006 but not in this layer` });
      }
    }
  }

  for (const file of files) {
    const lines = readFileSync(join(unitDir, file), "utf8").split("\n");
    let inFailureMapper = false;
    for (const [i, line] of lines.entries()) {
      if (/function\s+writerFailureResponse/.test(line)) inFailureMapper = true;
      else if (inFailureMapper && /^}/.test(line)) inFailureMapper = false;
      if (inFailureMapper && /if\s*\(\s*result\.state\s*===/.test(line)) {
        findings.push({ file, line: i + 1, rule: "reason-first",
          detail: "failure mapping branches on result.state; 006 §5 requires routing by result.reason" });
      }
    }
  }

  /*
   * 4. Diff fences. `check-blocks.ts` only reads ```ts fences, so the unit's
   * 18 diff hunks — a required part of DIFFLEVEL's before/after form — were
   * entirely unverified. Reconstruct the added side of each hunk (context
   * lines plus `+` lines, with `-` lines dropped) and check it for
   * placeholders and for balance, which is as far as a patch fragment can be
   * checked without its surrounding file.
   */
  for (const file of files) {
    const lines = readFileSync(join(unitDir, file), "utf8").split("\n");
    let hunk: { start: number; added: string[] } | null = null;
    for (const [i, line] of lines.entries()) {
      if (/^```diff\s*$/.test(line)) { hunk = { start: i + 1, added: [] }; continue; }
      if (hunk && /^```\s*$/.test(line)) {
        const text = hunk.added.join("\n");
        if (/\/\*\s*(…|\.\.\.)/.test(text)) {
          findings.push({ file, line: hunk.start, rule: "diff-placeholder",
            detail: "the added side of this hunk carries a placeholder body" });
        }
        /*
         * Bracket balance is NOT checked: a hunk legitimately shows the middle
         * of a file, so imbalance is the normal case, not a defect. Checking it
         * produced five false positives on correct patches. What IS checkable
         * without the surrounding file: a placeholder body (above), and an
         * added line that still carries a diff marker, which means the patch
         * was pasted into itself.
         */
        for (const [offset, added] of hunk.added.entries()) {
          if (/^\s*[+-]{1}[A-Za-z_{("']/.test(added)) {
            findings.push({ file, line: hunk.start + offset, rule: "diff-nested-marker",
              detail: "an added line still carries a diff marker" });
          }
        }
        hunk = null;
        continue;
      }
      if (hunk) {
        if (/^-/.test(line)) continue;           // removed: not part of the result
        hunk.added.push(/^\+/.test(line) ? line.slice(1) : line);
      }
    }
  }

  if (findings.length === 0) {
    console.log(`drift: clean across ${files.length} docs.`);
    return;
  }
  console.log(`drift: ${findings.length} finding(s)\n`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.detail}`);
  process.exitCode = 1;
}

if (import.meta.main) main();
