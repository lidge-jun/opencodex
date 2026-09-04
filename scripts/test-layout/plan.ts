import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { loadLayout, resolveTarget, type Layout } from "./schema";

export interface Move {
  from: string; // relative to repo root, posix
  to: string;
  target: string; // directory relative to tests/
  depth: number;
}

export function repoRootFromHere(): string {
  return join(import.meta.dir, "..", "..");
}

export function listTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "helpers" && entry !== "fixtures" && entry !== "node_modules") walk(full);
        continue;
      }
      if (entry.endsWith(".test.ts")) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(join(root, "tests"));
  return out;
}

export interface PlanResult {
  moves: Move[];
  unresolved: string[];
}

/** Every test file not yet at its target, optionally restricted to the named top-level domains. */
export function planMoves(layout: Layout, root: string, domains: string[] = []): PlanResult {
  const moves: Move[] = [];
  const unresolved: string[] = [];
  for (const rel of listTestFiles(root)) {
    const name = basename(rel);
    const target = resolveTarget(layout, name);
    if (target === null) {
      if (!layout.keepAtRoot.includes(name)) unresolved.push(rel);
      continue;
    }
    if (domains.length > 0 && !domains.includes(target.split("/")[0]!)) continue;
    const to = `tests/${target}/${name}`;
    if (rel === to) continue;
    moves.push({ from: rel, to, target, depth: target.split("/").length });
  }
  return { moves, unresolved };
}

/** Shared flag parser: every `--domain` must carry a value, so a forgotten one cannot become `[undefined]`. */
export function parseDomainArgs(argv: string[]): { domains: string[]; flags: Set<string> } {
  const domains: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--domain" || arg.startsWith("--domain=")) {
      const value = arg === "--domain" ? argv[++i] : arg.slice("--domain=".length);
      if (!value || value.startsWith("--")) throw new Error("--domain requires a value");
      domains.push(value);
      continue;
    }
    if (arg.startsWith("--")) flags.add(arg);
    else throw new Error(`unexpected argument ${arg}`);
  }
  return { domains, flags };
}

if (import.meta.main) {
  const { domains, flags } = parseDomainArgs(process.argv.slice(2));
  const layout = loadLayout();
  const result = planMoves(layout, repoRootFromHere(), domains);
  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const move of result.moves) console.log(`${move.from} -> ${move.to}`);
    for (const file of result.unresolved) console.log(`UNRESOLVED ${file}`);
    console.log(`${result.moves.length} move(s), ${result.unresolved.length} unresolved`);
  }
  process.exit(result.unresolved.length > 0 ? 1 : 0);
}
