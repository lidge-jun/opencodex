import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { LAYOUT_PATH, loadLayout, rewriteMetaDirEscapes, rewriteSource, scanEscapes, type Layout } from "./schema";
import { planMoves, repoRootFromHere, type Move } from "./plan";
import { filesNaming, runVerify } from "./verify";

/**
 * Move one slice of test files into their domain directories.
 *
 *   bun scripts/test-layout/move.ts --domain <a> [--domain <b> ...] [--dry-run]
 *
 * Order is preflight-all, move-all, rewrite-all, append migrated, escape scan, verify. The
 * preflight computes the full write set (every source file, every file that names a moved
 * path, scripts/test.ts when a serial-lane file is in the slice, layout.json) and refuses to
 * start if any of them is dirty; `git mv` itself would happily carry an unrelated edit inside a
 * rename. Exit 2 means the slice is fully moved and the lines printed as MANUAL need a human;
 * exit 1 means the automatic verify failed after a clean move.
 */

const SERIAL_LANE_SOURCE = "scripts/test.ts";

export interface MoveOptions {
  root: string;
  domains: string[];
  dryRun: boolean;
  layoutPath?: string;
  /** Skip the post-move verify (the tooling test drives verify itself). */
  skipVerify?: boolean;
  log?: (line: string) => void;
  git?: (args: string[]) => { status: number; stdout: string; stderr: string };
}

export interface MoveReport {
  moves: Move[];
  rewrittenLiteralFiles: string[];
  manual: Array<{ file: string; line: number; text: string }>;
  suppressed: Array<{ file: string; line: number; text: string }>;
  verifyOk: boolean | null;
  exitCode: 0 | 1 | 2;
}

function defaultGit(root: string) {
  return (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };
}

function serialLaneFiles(root: string): string[] {
  const path = join(root, SERIAL_LANE_SOURCE);
  if (!existsSync(path)) return [];
  const block = readFileSync(path, "utf8").match(/SERIAL_FULL_SUITE_FILES = \[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map(m => basename(m[1]!));
}

function scanMoved(root: string, moves: Move[], read: (move: Move) => string, manual: MoveReport["manual"], suppressed: MoveReport["suppressed"]): void {
  void root;
  for (const move of moves) {
    for (const hit of scanEscapes(read(move))) {
      (hit.suppressed ? suppressed : manual).push({ file: move.to, line: hit.line, text: hit.text.trim() });
    }
  }
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
    return { moves: [], rewrittenLiteralFiles: [], manual: [], suppressed: [], verifyOk: null, exitCode: 0 };
  }

  // Preflight: the complete write set.
  const literalTargets = new Map<string, string[]>();
  for (const move of moves) {
    for (const file of filesNaming(root, move.from)) {
      if (file === move.from) continue;
      const list = literalTargets.get(file) ?? [];
      list.push(move.from);
      literalTargets.set(file, list);
    }
  }
  const serial = new Set(serialLaneFiles(root));
  const touchesSerial = moves.some(move => serial.has(basename(move.from)));
  if (touchesSerial && !literalTargets.has(SERIAL_LANE_SOURCE)) literalTargets.set(SERIAL_LANE_SOURCE, []);
  const layoutRel = relative(root, layoutPath).split("\\").join("/");
  const writeSet = new Set<string>([...moves.map(move => move.from), ...literalTargets.keys(), layoutRel]);
  const status = git(["status", "--porcelain", "--", ...writeSet]);
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const dirty = status.stdout.split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(`move: refusing to start, dirty files in the write set:\n  ${dirty.join("\n  ")}`);
  }

  log(`move: ${moves.length} file(s) across ${domains.join(", ")}${dryRun ? " (dry run)" : ""}`);
  for (const move of moves) log(`  ${move.from} -> ${move.to}`);

  const manual: MoveReport["manual"] = [];
  const suppressed: MoveReport["suppressed"] = [];

  if (dryRun) {
    for (const [file, literals] of literalTargets) log(`  rewrite literals in ${file}: ${literals.join(", ") || "(serial lanes)"}`);
    // Rewrite in memory so the dry run reports exactly the MANUAL lines the real move would.
    scanMoved(root, moves, move => rewriteMetaDirEscapes(rewriteSource(readFileSync(join(root, move.from), "utf8"), move.depth), move.depth).source, manual, suppressed);
    for (const hit of suppressed) log(`  layout: local would be honoured at ${hit.file}:${hit.line}`);
    for (const hit of manual) log(`MANUAL ${hit.file}:${hit.line}: ${hit.text}`);
    log(`move: dry run, ${manual.length} MANUAL line(s) expected`);
    return { moves, rewrittenLiteralFiles: [...literalTargets.keys()], manual, suppressed, verifyOk: null, exitCode: manual.length > 0 ? 2 : 0 };
  }

  for (const move of moves) {
    mkdirSync(join(root, dirname(move.to)), { recursive: true });
    const mv = git(["mv", move.from, move.to]);
    if (mv.status !== 0) throw new Error(`git mv ${move.from} ${move.to} failed: ${mv.stderr}`);
  }

  for (const move of moves) {
    const path = join(root, move.to);
    const before = readFileSync(path, "utf8");
    const after = rewriteMetaDirEscapes(rewriteSource(before, move.depth), move.depth).source;
    if (after !== before) writeFileSync(path, after);
  }

  const rewrittenLiteralFiles: string[] = [];
  const byFrom = new Map(moves.map(move => [move.from, move.to] as const));
  for (const [file] of literalTargets) {
    const path = join(root, byFrom.get(file) ?? file);
    let text = readFileSync(path, "utf8");
    const original = text;
    for (const [from, to] of byFrom) {
      text = text.split(from).join(to);
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

  const migrated = new Set(layout.migrated);
  for (const domain of domains) migrated.add(domain);
  layout.migrated = [...migrated].sort();
  writeFileSync(layoutPath, JSON.stringify(layout, null, 2) + "\n");

  scanMoved(root, moves, move => readFileSync(join(root, move.to), "utf8"), manual, suppressed);
  for (const hit of suppressed) log(`  layout: local honoured at ${hit.file}:${hit.line}`);
  for (const hit of manual) log(`MANUAL ${hit.file}:${hit.line}: ${hit.text}`);
  if (manual.length > 0) {
    log(`move: done, ${manual.length} MANUAL line(s) - edit them, then run verify.ts`);
    return { moves, rewrittenLiteralFiles, manual, suppressed, verifyOk: null, exitCode: 2 };
  }
  if (options.skipVerify) {
    log("move: done, 0 MANUAL line(s); verify skipped by caller");
    return { moves, rewrittenLiteralFiles, manual, suppressed, verifyOk: null, exitCode: 0 };
  }
  const verify = runVerify({ root, domains, log, layoutPath });
  log(`move: done, verify ${verify.ok ? "passed" : "FAILED"}`);
  return { moves, rewrittenLiteralFiles, manual, suppressed, verifyOk: verify.ok, exitCode: verify.ok ? 0 : 1 };
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
