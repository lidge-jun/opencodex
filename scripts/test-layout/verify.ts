import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadLayout, scanEscapes } from "./schema";
import { listTestFiles, repoRootFromHere } from "./plan";

/**
 * Verify one or more migrated domains:
 *   1. no stale `tests/<basename>` literal for any file in the domain remains anywhere,
 *   2. the escape scanner (same one the mover uses) reports nothing unsuppressed,
 *   3. the domain typechecks under scripts/test-layout/tsconfig.verify.json (via a temp config
 *      that extends it with absolute include paths, since `include` is replaced, not merged),
 *   4. `bun test --isolate tests/<domain>` passes.
 */

export interface VerifyOptions {
  root: string;
  domains: string[];
  skipTests?: boolean;
  log?: (line: string) => void;
}

export interface VerifyReport {
  staleLiterals: Array<{ file: string; literal: string }>;
  manual: Array<{ file: string; line: number; text: string }>;
  suppressed: Array<{ file: string; line: number; text: string }>;
  typecheckExit: number;
  testExit: number;
  ok: boolean;
}

const SWEEP_ROOTS = ["tests", "scripts", ".github", "AGENTS.md", "src", "docs-site", "structure", "bunfig.toml"];

function rgLiteral(root: string, literal: string): string[] {
  const proc = Bun.spawnSync(["rg", "-l", "--fixed-strings", "--no-messages", literal, ...SWEEP_ROOTS], {
    cwd: root, stdout: "pipe", stderr: "pipe",
  });
  return proc.exitCode === 0 ? proc.stdout.toString().split("\n").filter(Boolean) : [];
}

export function runVerify(options: VerifyOptions): VerifyReport {
  const { root, domains } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const layout = loadLayout();
  const files = listTestFiles(root).filter(rel => domains.some(d => rel.startsWith(`tests/${d}/`)));

  const staleLiterals: VerifyReport["staleLiterals"] = [];
  const manual: VerifyReport["manual"] = [];
  const suppressed: VerifyReport["suppressed"] = [];
  for (const rel of files) {
    const literal = `tests/${basename(rel)}`;
    for (const file of rgLiteral(root, literal)) {
      // A hit inside a file that mentions "tests/<basename>" only as a substring of the new
      // path (tests/server/x.test.ts contains "tests/x.test.ts"? no - it contains "server/x") is
      // impossible, so any hit is stale by construction.
      staleLiterals.push({ file, literal });
    }
    for (const hit of scanEscapes(readFileSync(join(root, rel), "utf8"))) {
      (hit.suppressed ? suppressed : manual).push({ file: rel, line: hit.line, text: hit.text.trim() });
    }
  }
  for (const hit of suppressed) log(`layout: local honoured at ${hit.file}:${hit.line}`);
  for (const hit of manual) log(`MANUAL ${hit.file}:${hit.line}: ${hit.text}`);
  for (const stale of staleLiterals) log(`STALE ${stale.file} still names ${stale.literal}`);

  // Typecheck through a temp config with absolute paths.
  const tmpDir = join(root, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpConfig = join(tmpDir, `tsconfig.verify.${process.pid}.json`);
  const base = JSON.parse(readFileSync(join(root, "scripts", "test-layout", "tsconfig.verify.json"), "utf8")) as { include: string[] };
  const include = [
    ...base.include.map(entry => join(root, "scripts", "test-layout", entry)),
    ...domains.map(d => join(root, "tests", d, "**", "*.ts")),
  ];
  writeFileSync(tmpConfig, JSON.stringify({ extends: join(root, "scripts", "test-layout", "tsconfig.verify.json"), include }, null, 2));
  let typecheckExit: number;
  try {
    const tsc = Bun.spawnSync(["bun", "x", "tsc", "--noEmit", "-p", tmpConfig], { cwd: root, stdout: "inherit", stderr: "inherit" });
    typecheckExit = tsc.exitCode;
  } finally {
    rmSync(tmpConfig, { force: true });
  }
  log(`typecheck exit ${typecheckExit}`);

  let testExit = 0;
  if (!options.skipTests && domains.length > 0) {
    const proc = Bun.spawnSync(["bun", "test", "--isolate", ...domains.map(d => `tests/${d}`)], { cwd: root, stdout: "inherit", stderr: "inherit" });
    testExit = proc.exitCode;
    log(`bun test exit ${testExit}`);
  }

  const ok = staleLiterals.length === 0 && manual.length === 0 && typecheckExit === 0 && testExit === 0;
  return { staleLiterals, manual, suppressed, typecheckExit, testExit, ok };
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
