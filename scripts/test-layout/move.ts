import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LAYOUT_PATH, loadLayout, rewriteMetaDirEscapes, rewriteSource, scanEscapes, type Layout } from "./schema";
import { planMoves, repoRootFromHere, type Move } from "./plan";

/**
 * Move one slice of test files into their domain directories.
 *
 *   bun scripts/test-layout/move.ts --domain <a> [--domain <b> ...] [--dry-run]
 *
 * Order is preflight-all, move-all, rewrite-all, append migrated, then the escape scan. The
 * preflight computes the full write set (every source file, every file that names a moved
 * path, scripts/test.ts when a serial-lane file is in the slice, layout.json) and refuses to
 * start if any of them is dirty; `git mv` itself would happily carry an unrelated edit inside a
 * rename. Exit 2 means the slice is fully moved and the lines printed as MANUAL need a human.
 */

const SERIAL_LANE_SOURCE = "scripts/test.ts";
const LITERAL_SWEEP_ROOTS = ["tests", "scripts", ".github", "AGENTS.md", "src", "docs-site", "structure", "bunfig.toml"];

export interface MoveOptions {
  root: string;
  domains: string[];
  dryRun: boolean;
  layoutPath?: string;
  log?: (line: string) => void;
  git?: (args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface MoveReport {
  moves: Move[];
  rewrittenLiteralFiles: string[];
  manual: Array<{ file: string; line: number; text: string }>;
  suppressed: Array<{ file: string; line: number; text: string }>;
  exitCode: 0 | 2;
}

function defaultGit(root: string) {
  return (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };
}

function rgFilesNaming(root: string, literal: string): string[] {
  const proc = Bun.spawnSync(
    ["rg", "-l", "--fixed-strings", "--no-messages", literal, ...LITERAL_SWEEP_ROOTS.filter(p => existsSync(join(root, p)))],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(`rg failed while sweeping for ${literal}: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().split("\n").filter(Boolean);
}

function serialLaneFiles(root: string): string[] {
  const source = readFileSync(join(root, SERIAL_LANE_SOURCE), "utf8");
  const block = source.match(/SERIAL_FULL_SUITE_FILES = \[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map(m => basename(m[1]!));
}

export function runMove(options: MoveOptions): MoveReport {
  const { root, domains, dryRun } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const git = options.git ?? defaultGit(root);
  const layoutPath = options.layoutPath ?? LAYOUT_PATH;
  const layout: Layout = loadLayout(layoutPath);
  if (domains.length === 0) throw new Error("move: at least one --domain is required");
  for (const domain of domains) {
    if (!(domain in layout.domains)) throw new Error(`move: unknown domain ${domain}`);
  }

  const { moves, unresolved } = planMoves(layout, root, domains);
  if (unresolved.length > 0) {
    throw new Error(`move: ${unresolved.length} unresolved file(s); fix layout.json first:\n  ${unresolved.join("\n  ")}`);
  }
  if (moves.length === 0) {
    log("move: nothing to do");
    return { moves: [], rewrittenLiteralFiles: [], manual: [], suppressed: [], exitCode: 0 };
  }

  // Preflight: the complete write set.
  const literalTargets = new Map<string, string[]>(); // file -> literals it names
  for (const move of moves) {
    for (const file of rgFilesNaming(root, move.from)) {
      if (file === move.from) continue;
      const list = literalTargets.get(file) ?? [];
      list.push(move.from);
      literalTargets.set(file, list);
    }
  }
  const serial = new Set(serialLaneFiles(root));
  const touchesSerial = moves.some(move => serial.has(basename(move.from)));
  // scripts/test.ts names serial-lane files relative to tests/, so the literal sweep above
  // (which looks for "tests/<basename>") does not find it; add it explicitly.
  if (touchesSerial && !literalTargets.has(SERIAL_LANE_SOURCE)) literalTargets.set(SERIAL_LANE_SOURCE, []);
  const writeSet = new Set<string>([
    ...moves.map(move => move.from),
    ...literalTargets.keys(),
    ...(touchesSerial ? [SERIAL_LANE_SOURCE] : []),
    layoutPath.startsWith(root) ? layoutPath.slice(root.length + 1) : layoutPath,
  ]);
  const status = git(["status", "--porcelain", "--", ...writeSet]);
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const dirty = status.stdout.split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(`move: refusing to start, dirty files in the write set:\n  ${dirty.join("\n  ")}`);
  }

  log(`move: ${moves.length} file(s) across ${domains.join(", ")}${dryRun ? " (dry run)" : ""}`);
  for (const move of moves) log(`  ${move.from} -> ${move.to}`);

  if (dryRun) {
    for (const [file, literals] of literalTargets) log(`  rewrite literals in ${file}: ${literals.join(", ")}`);
    if (touchesSerial) log(`  rewrite serial lanes in ${SERIAL_LANE_SOURCE}`);
    return { moves, rewrittenLiteralFiles: [...literalTargets.keys()], manual: [], suppressed: [], exitCode: 0 };
  }

  // Move.
  for (const move of moves) {
    mkdirSync(join(root, dirname(move.to)), { recursive: true });
    const mv = git(["mv", move.from, move.to]);
    if (mv.status !== 0) throw new Error(`git mv ${move.from} ${move.to} failed: ${mv.stderr}`);
  }

  // Rewrite the moved files' own specifiers.
  for (const move of moves) {
    const path = join(root, move.to);
    const before = readFileSync(path, "utf8");
    const after = rewriteMetaDirEscapes(rewriteSource(before, move.depth), move.depth).source;
    if (after !== before) writeFileSync(path, after);
  }

  // Rewrite every literal that named a moved path.
  const rewrittenLiteralFiles: string[] = [];
  const byFrom = new Map(moves.map(move => [move.from, move.to] as const));
  for (const [file] of literalTargets) {
    const path = join(root, byFrom.get(file) ?? file);
    let text = readFileSync(path, "utf8");
    const original = text;
    for (const [from, to] of byFrom) {
      text = text.split(from).join(to);
      // "./tests/x" forms are covered by the plain split; the serial-lane table stores paths
      // relative to tests/ as quoted strings, so rewrite those too.
      if (file === SERIAL_LANE_SOURCE && serial.has(basename(from))) {
        const rel = from.slice("tests/".length);
        text = text.split(`"${rel}"`).join(`"${to.slice("tests/".length)}"`);
      }
    }
    if (text !== original) {
      writeFileSync(path, text);
      rewrittenLiteralFiles.push(file);
      log(`  rewrote literals in ${file}`);
    }
  }

  // Append migrated and persist.
  const migrated = new Set(layout.migrated);
  for (const domain of domains) migrated.add(domain);
  layout.migrated = [...migrated].sort();
  writeFileSync(layoutPath, JSON.stringify(layout, null, 2) + "\n");

  // Escape scan over the moved files.
  const manual: MoveReport["manual"] = [];
  const suppressed: MoveReport["suppressed"] = [];
  for (const move of moves) {
    const source = readFileSync(join(root, move.to), "utf8");
    for (const hit of scanEscapes(source)) {
      (hit.suppressed ? suppressed : manual).push({ file: move.to, line: hit.line, text: hit.text.trim() });
    }
  }
  for (const hit of suppressed) log(`  layout: local honoured at ${hit.file}:${hit.line}`);
  for (const hit of manual) log(`MANUAL ${hit.file}:${hit.line}: ${hit.text}`);
  const exitCode = manual.length > 0 ? 2 : 0;
  log(`move: done, ${manual.length} MANUAL line(s)${exitCode === 2 ? " - edit them, then run verify.ts" : ""}`);
  return { moves, rewrittenLiteralFiles, manual, suppressed, exitCode };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const domains: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--domain") { domains.push(argv[++i]!); continue; }
    if (argv[i]!.startsWith("--domain=")) { domains.push(argv[i]!.slice("--domain=".length)); continue; }
    if (argv[i] === "--dry-run") dryRun = true;
  }
  try {
    const report = runMove({ root: repoRootFromHere(), domains, dryRun });
    process.exit(report.exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
