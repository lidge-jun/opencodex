/**
 * Typecheck the fenced TypeScript in a devlog unit's decade docs.
 *
 * DIFFLEVEL-ROADMAP-01 asks for copy-paste-executable bodies. Five audit
 * rounds showed the cost of writing those without a compiler: every genuine
 * design fault was caught by review, but hand-transcription defects (a stale
 * import, a type declared one way and used another, a `/* … *\/` placeholder)
 * kept regenerating because nothing could see them. `bun run typecheck` reads
 * `src/`; it has no opinion about a fenced block in markdown.
 *
 * So this closes the gap rather than lowering the bar: extract every ```ts /
 * ```tsx block, write them to a scratch dir, and run `tsc --noEmit` over them.
 * Placeholders are reported as such instead of silently passing.
 *
 * Usage:  bun devlog/_plan/260802_client_toggle_api/tools/check-blocks.ts [--dir <unit>] [--emit]
 *
 * This is a plan-verification tool that lives with the unit it verifies; it is
 * not part of the product build and nothing in src/ imports it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface Block {
  file: string;
  index: number;
  startLine: number;
  lang: string;
  body: string;
}

/** A body we deliberately did not write out. Reported, never silently passed. */
const PLACEHOLDER = /\/\*\s*(…|\.\.\.|identical preflight)[^*]*\*\//;

/**
 * A block whose bodies are deliberately absent because the instruction is a
 * VERBATIM CUT from named source lines — retyping a working function by hand
 * is precisely the defect class this tool exists to catch, so the plan names
 * the lines instead. Marked explicitly so it is a decision, not an omission.
 */
const VERBATIM_CUT = /\/\*\s*moved verbatim\s*\*\//;

/**
 * A block that is an excerpt rather than a compilable unit: a diff (its lines
 * carry +/- markers), an interface-only sketch, or a fragment lifted from the
 * middle of a function. These are legitimate documentation and are counted
 * separately rather than forced through the compiler, which would only report
 * that a diff is not TypeScript.
 */
function classify(body: string): "diff" | "fragment" | "unit" {
  const lines = body.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return "fragment";
  if (lines.some(l => /^[+-] /.test(l) || /^[+-]{1}[A-Za-z{}\s]/.test(l))) return "diff";
  // A unit starts at top level: import/export/type/interface/const/function.
  const first = lines[0]!.trimStart();
  const topLevel = /^(import|export|type|interface|const|let|function|class|\/\*|\/\/|declare)/;
  if (!topLevel.test(first)) return "fragment";
  /*
   * A block that STARTS at top level is a unit, full stop.
   *
   * Brace balance used to decide this, and that was a hole: an unmatched `}`
   * — exactly the defect worth catching — made a paste-ready body look like a
   * mid-file excerpt, so it was excluded from compilation and the run went
   * green. A syntax error must never be able to disable its own check
   * (A-gate round 8, blocker 1). Imbalance is now tsc's problem, which is
   * what tsc is for.
   *
   * A genuine excerpt therefore has to look like one: start mid-expression,
   * or be fenced as `diff`.
   */
  return "unit";
}

export function extractBlocks(file: string, text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let open: { lang: string; startLine: number; body: string[] } | null = null;
  for (const [i, line] of lines.entries()) {
    const fence = /^```(ts|tsx|typescript)\s*$/.exec(line);
    if (!open && fence) {
      open = { lang: fence[1]!, startLine: i + 1, body: [] };
      continue;
    }
    if (open && /^```\s*$/.test(line)) {
      blocks.push({ file, index: blocks.length, startLine: open.startLine, lang: open.lang, body: open.body.join("\n") });
      open = null;
      continue;
    }
    if (open) open.body.push(line);
  }
  return blocks;
}

function main(): void {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const unitDir = dirFlag === -1 ? dirname(dirname(import.meta.path)) : args[dirFlag + 1]!;
  const docs = readdirSync(unitDir).filter(name => /^\d{3}.*\.md$/.test(name)).sort();

  const all: Block[] = [];
  for (const doc of docs) {
    all.push(...extractBlocks(doc, readFileSync(join(unitDir, doc), "utf8")));
  }

  const placeholders = all.filter(b => PLACEHOLDER.test(b.body));
  const verbatim = all.filter(b => !PLACEHOLDER.test(b.body) && VERBATIM_CUT.test(b.body));
  const remaining = all.filter(b => !PLACEHOLDER.test(b.body) && !VERBATIM_CUT.test(b.body));
  const diffs = remaining.filter(b => classify(b.body) === "diff");
  const fragments = remaining.filter(b => classify(b.body) === "fragment");
  const checkable = remaining.filter(b => classify(b.body) === "unit");

  const outDir = join(unitDir, ".blocks");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const block of checkable) {
    const name = `${basename(block.file, ".md")}__${String(block.index).padStart(2, "0")}.${block.lang === "tsx" ? "tsx" : "ts"}`;
    writeFileSync(join(outDir, name), block.body + "\n");
  }

  console.log(`docs: ${docs.length}  blocks: ${all.length}`);
  console.log(`  compilable units: ${checkable.length}`);
  console.log(`  diffs (excerpt):  ${diffs.length}`);
  console.log(`  fragments:        ${fragments.length}`);
  console.log(`  verbatim cuts:    ${verbatim.length}`);
  console.log(`  placeholders:     ${placeholders.length}`);
  for (const p of placeholders) {
    console.log(`  placeholder: ${p.file}:${p.startLine}`);
  }
  if (placeholders.length > 0) {
    console.log("\nFAIL: a placeholder body is not a copy-paste-executable plan.");
    process.exitCode = 1;
  }
  console.log(`\nwrote ${checkable.length} files to ${outDir}`);

  /*
   * Run tsc here rather than printing a command to copy. A ritual whose flag
   * order can silently change the result is the same class of problem this
   * tool exists to remove, so the settings live in a tsconfig next to the
   * files they govern.
   *
   * `noResolve` is deliberate: each block is checked as a self-contained unit
   * for syntax and internal consistency. Cross-module identifier resolution
   * belongs to the implementing phase, where the real imports exist and the
   * repository's own `bun run typecheck` covers it.
   */
  writeFileSync(join(outDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      noEmit: true, skipLibCheck: true, strict: true, noResolve: true,
      target: "esnext", module: "esnext", moduleResolution: "bundler",
      // `preserve` keeps JSX syntax checked without demanding React's type
      // definitions, which `noResolve` deliberately withholds.
      jsx: "preserve", types: [],
      // Unresolved cross-module identifiers are expected here by design;
      // the goal is syntax and internal consistency, not link-time truth.
      noImplicitAny: false,
    },
    include: ["*.ts", "*.tsx"],
  }, null, 2) + "\n");

  const tsc = spawnSync("bun", ["x", "tsc", "-p", "."], { cwd: outDir, encoding: "utf8" });
  const raw = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`.trim();
  /*
   * Keep only what this check can actually speak to. With `noResolve` every
   * cross-module name is unknown by construction, so TS2304/TS2503/TS2307 and
   * the ambient-JSX complaints are noise, not findings. Syntax errors
   * (TS1xxx) and same-file inconsistencies are the signal.
   */
  /*
   * TS2304/2503/2307/2580/2591/2868 — a name from another module or from the
   *   ambient environment, which `noResolve` withholds on purpose.
   * TS7026 — JSX intrinsics, same reason.
   * TS2391 — a declaration-only signature block (an interface sketch), which
   *   is a legitimate documentation form.
   * TS1375 — top-level await in a block excerpted from inside a module.
   * TS18046 — `unknown` that a real `instanceof` narrowing would resolve, if
   *   the class it narrows against were resolvable. Under `noResolve` it is
   *   not, so this reports the flag rather than the code.
   */
  const NOISE = /TS(2304|2503|2307|2580|2591|2688|2868|7026|2391|1375|18046)\b/;
  const findings = raw.split("\n").filter(line => line.trim() && !NOISE.test(line));
  if (findings.length > 0) {
    console.log(`\ntsc reported ${findings.length} finding(s):\n${findings.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`\ntsc: clean across ${checkable.length} blocks.`);
  }
}

if (import.meta.main) main();
