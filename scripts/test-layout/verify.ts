import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LAYOUT_PATH, loadLayout, scanEscapes } from "./schema";
import { listTestFiles, parseDomainArgs, repoRootFromHere } from "./plan";

/**
 * Verify one or more migrated domains:
 *   1. no stale `tests/<basename>` literal for any file in the domain remains anywhere,
 *   2. the escape scanner (the same one the mover uses) reports nothing unsuppressed,
 *   3. the domain has no module-resolution errors under scripts/test-layout/tsconfig.verify.json
 *      (via a temp config that extends it with absolute include paths, since `include` is
 *      replaced, not merged). Tests are not strict-typechecked by the root tsconfig and carry
 *      pre-existing type errors, so only the error classes a move can introduce count:
 *      TS2307 (cannot find module), TS2306 (not a module), TS6053 (file not found), TS5097.
 *   4. `bun test --isolate tests/<domain>` passes.
 */

export interface VerifyOptions {
  root: string;
  domains: string[];
  skipTests?: boolean;
  layoutPath?: string;
  log?: (line: string) => void;
}

export interface VerifyReport {
  staleLiterals: Array<{ file: string; literal: string }>;
  manual: Array<{ file: string; line: number; text: string }>;
  suppressed: Array<{ file: string; line: number; text: string }>;
  typecheckExit: number;
  resolutionErrors: string[];
  testExit: number;
  ok: boolean;
}

/**
 * Everything that may name a test path as text. Shared with move.ts so the preflight write set
 * and the post-move STALE check see the same files. `devlog/` is deliberately absent: a unit
 * records where a file lived when it was written, and rewriting 59 old plan documents per slice
 * (measured on the first slice) buries the real diff without changing what any tool reads.
 */
export const SWEEP_ROOTS = [
  "tests", "scripts", ".github", "src", "gui/src", "gui/tests", "bin", "docs", "docs-site", "structure", "skills",
  "AGENTS.md", "AGENTS_INSTALL.md", "MAINTAINERS.md", "CONTRIBUTING.md", "README.md", "CREDITS.md",
  "bunfig.toml", "package.json", ".gitignore", ".npmignore",
];
// dist/ is a build output (gitignored) and is rebuilt from src; it is deliberately not swept.

/**
 * Tracked files under SWEEP_ROOTS that contain `literal` as text. Uses `git grep` so the sweep
 * needs nothing beyond git (the Linux CI runners do not ship ripgrep) and honours the index:
 * gitignored reference clones and build output are never scanned.
 */
export function filesNaming(root: string, literal: string): string[] {
  return filesNamingAny(root, [literal]).get(literal) ?? [];
}

/** One `git grep` for many literals; returns literal -> tracked files (posix paths) that contain it. */
export function filesNamingAny(root: string, literals: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (literals.length === 0) return result;
  const roots = SWEEP_ROOTS.filter(p => existsSync(join(root, p)));
  if (roots.length === 0) return result;
  const patterns = literals.flatMap(literal => ["-e", literal]);
  // -n -o prints "path:line:match" so one pass attributes each hit to its literal.
  const proc = Bun.spawnSync(["git", "grep", "-n", "-o", "--fixed-strings", ...patterns, "--", ...roots], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  // git grep exits 1 for "no matches"; anything above that is an execution error.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(`git grep failed while sweeping (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  if (proc.exitCode !== 0) return result;
  for (const line of proc.stdout.toString().split("\n")) {
    if (!line) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first === -1 || second === -1) continue;
    const file = line.slice(0, first).split("\\").join("/");
    const match = line.slice(second + 1);
    const list = result.get(match) ?? [];
    if (!list.includes(file)) list.push(file);
    result.set(match, list);
  }
  return result;
}

export function runVerify(options: VerifyOptions): VerifyReport {
  const { root, domains } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  if (domains.length === 0) throw new Error("verify: at least one --domain is required");
  loadLayout(options.layoutPath ?? LAYOUT_PATH); // validates the map is well-formed
  const files = listTestFiles(root).filter(rel => domains.some(d => rel.startsWith(`tests/${d}/`)));
  if (files.length === 0) throw new Error(`verify: no test files under tests/{${domains.join(",")}}; has the slice moved?`);

  const staleLiterals: VerifyReport["staleLiterals"] = [];
  const manual: VerifyReport["manual"] = [];
  const suppressed: VerifyReport["suppressed"] = [];
  // One sweep for the whole slice instead of one repository scan per file.
  const literals = files.map(rel => `tests/${basename(rel)}`);
  const staleByFile = filesNamingAny(root, literals);
  for (const rel of files) {
    const literal = `tests/${basename(rel)}`;
    // "tests/<basename>" cannot be a substring of any "tests/<dir>/<other>" (verified over all
    // 1061 basenames in the tooling test), so any hit is stale by construction.
    for (const file of staleByFile.get(literal) ?? []) staleLiterals.push({ file, literal });
    for (const hit of scanEscapes(readFileSync(join(root, rel), "utf8"))) {
      (hit.suppressed ? suppressed : manual).push({ file: rel, line: hit.line, text: hit.text.trim() });
    }
  }
  for (const hit of suppressed) log(`layout: local honoured at ${hit.file}:${hit.line}`);
  for (const hit of manual) log(`MANUAL ${hit.file}:${hit.line}: ${hit.text}`);
  for (const stale of staleLiterals) log(`STALE ${stale.file} still names ${stale.literal}`);

  const baseConfig = join(root, "scripts", "test-layout", "tsconfig.verify.json");
  let typecheckExit = 0;
  let resolutionErrors: string[] = [];
  if (existsSync(baseConfig)) {
    const tmpDir = join(root, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tmpConfig = join(tmpDir, `tsconfig.verify.${process.pid}.json`);
    const base = JSON.parse(readFileSync(baseConfig, "utf8")) as { include: string[] };
    const include = [
      ...base.include.map(entry => join(root, "scripts", "test-layout", entry)),
      ...domains.map(d => join(root, "tests", d, "**", "*.ts")),
    ];
    writeFileSync(tmpConfig, JSON.stringify({ extends: baseConfig, include }, null, 2));
    try {
      const tsc = Bun.spawnSync(["bun", "x", "tsc", "--noEmit", "-p", tmpConfig], { cwd: root, stdout: "pipe", stderr: "pipe" });
      typecheckExit = tsc.exitCode;
      const output = tsc.stdout.toString() + tsc.stderr.toString();
      resolutionErrors = output.split("\n").filter(line => /error TS(2307|2306|6053|5097)\b/.test(line));
    } finally {
      rmSync(tmpConfig, { force: true });
    }
    for (const line of resolutionErrors) log(`RESOLVE ${line}`);
    if (typecheckExit !== 0 && resolutionErrors.length === 0) {
      log("typecheck exited non-zero without module-resolution errors; those errors are not attributed to the move and do not fail verify (tests are outside the strict root tsconfig). Compare against the same command on origin/dev if in doubt.");
    }
    log(`typecheck exit ${typecheckExit}, ${resolutionErrors.length} module-resolution error(s)`);
  }

  let testExit = 0;
  if (!options.skipTests && domains.length > 0) {
    const proc = Bun.spawnSync(["bun", "test", "--isolate", ...domains.map(d => `tests/${d}`)], { cwd: root, stdout: "inherit", stderr: "inherit" });
    testExit = proc.exitCode;
    log(`bun test exit ${testExit}`);
  }

  const ok = staleLiterals.length === 0 && manual.length === 0 && resolutionErrors.length === 0 && testExit === 0;
  return { staleLiterals, manual, suppressed, typecheckExit, resolutionErrors, testExit, ok };
}

if (import.meta.main) {
  try {
    const { domains, flags } = parseDomainArgs(process.argv.slice(2));
    const report = runVerify({ root: repoRootFromHere(), domains, skipTests: flags.has("--skip-tests") });
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
