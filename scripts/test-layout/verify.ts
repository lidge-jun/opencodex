import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LAYOUT_PATH, loadLayout, scanEscapes } from "./schema";
import { listTestFiles, repoRootFromHere } from "./plan";

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
 * and the post-move STALE check see the same files. `devlog/_fin` is history: it records where
 * a file lived when the unit closed and is deliberately not rewritten. Open `devlog/_plan` units
 * are live documents and are.
 */
export const SWEEP_ROOTS = [
  "tests", "scripts", ".github", "src", "gui/src", "gui/tests", "bin", "docs", "docs-site", "structure", "devlog/_plan", "skills",
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
  const roots = SWEEP_ROOTS.filter(p => existsSync(join(root, p)));
  if (roots.length === 0) return [];
  const proc = Bun.spawnSync(["git", "grep", "-l", "--fixed-strings", "-e", literal, "--", ...roots], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  // git grep exits 1 for "no matches"; anything above that is an execution error.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(`git grep failed while sweeping for ${literal} (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return proc.exitCode === 0 ? proc.stdout.toString().split("\n").filter(Boolean) : [];
}

export function runVerify(options: VerifyOptions): VerifyReport {
  const { root, domains } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  loadLayout(options.layoutPath ?? LAYOUT_PATH); // validates the map is well-formed
  const files = listTestFiles(root).filter(rel => domains.some(d => rel.startsWith(`tests/${d}/`)));

  const staleLiterals: VerifyReport["staleLiterals"] = [];
  const manual: VerifyReport["manual"] = [];
  const suppressed: VerifyReport["suppressed"] = [];
  for (const rel of files) {
    const literal = `tests/${basename(rel)}`;
    // "tests/<basename>" cannot be a substring of any "tests/<dir>/<other>" (verified over all
    // 1061 basenames in the tooling test), so any hit is stale by construction.
    for (const file of filesNaming(root, literal)) staleLiterals.push({ file, literal });
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
  const argv = process.argv.slice(2);
  const domains: string[] = [];
  let skipTests = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--domain") { domains.push(argv[++i]!); continue; }
    if (argv[i]!.startsWith("--domain=")) { domains.push(argv[i]!.slice("--domain=".length)); continue; }
    if (argv[i] === "--skip-tests") skipTests = true;
  }
  const report = runVerify({ root: repoRootFromHere(), domains, skipTests });
  process.exit(report.ok ? 0 : 1);
}
