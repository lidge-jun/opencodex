import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

export const THRESHOLD = 2000;
export const BASELINE_REL = "tests/fixtures/file-size-baseline.json";

export const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".cjs",
  ".mjs",
  ".json",
  ".css",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
]);

export const EXCLUDED_PREFIXES = [
  "devlog/",
  "assets/",
  "docs-site/public/",
  "docs-site/src/assets/",
  "gui/dist/",
] as const;

export const EXCLUDED_EXACT = new Set(["bun.lock", "gui/dist"]);

export const GENERATED_PATHS = [
  "scripts/model-metadata.source.json",
  "src/adapters/cursor/gen/agent_pb.ts",
  "gui/src/i18n/de.ts",
  "gui/src/i18n/en.ts",
  "gui/src/i18n/fr.ts",
  "gui/src/i18n/ja.ts",
  "gui/src/i18n/ko.ts",
  "gui/src/i18n/ru.ts",
  "gui/src/i18n/tr.ts",
  "gui/src/i18n/zh.ts",
  "gui/src/i18n/zh-TW.ts",
  "docs-site/src/data/frontier-benchmarks.json",
] as const;

export type Verdict =
  | "NEW_OVERSIZED"
  | "GREW"
  | "SHRANK"
  | "GENERATED"
  | "UNCHANGED"
  | "NEW_OK";

export type Baseline = {
  generated: string[];
  files: Record<string, number>;
};

export type FileSize = {
  path: string;
  lines: number;
};

export type Evaluation = FileSize & {
  verdict: Verdict;
};

export function countLines(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function isScannedPath(path: string): boolean {
  if (EXCLUDED_EXACT.has(path)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return SCAN_EXTENSIONS.has(extname(path));
}

export function evaluate(files: FileSize[], baseline: Baseline): Evaluation[] {
  const generated = new Set(baseline.generated);
  return files.map((file) => {
    if (generated.has(file.path)) return { ...file, verdict: "GENERATED" };
    const cap = baseline.files[file.path];
    if (cap === undefined) {
      return { ...file, verdict: file.lines >= THRESHOLD ? "NEW_OVERSIZED" : "NEW_OK" };
    }
    if (file.lines > cap) return { ...file, verdict: "GREW" };
    if (file.lines < cap) return { ...file, verdict: "SHRANK" };
    return { ...file, verdict: "UNCHANGED" };
  });
}

export function isOffender(row: Evaluation): boolean {
  return row.verdict === "NEW_OVERSIZED" || row.verdict === "GREW";
}

export function gitLsFiles(repoRoot: string): string[] {
  const result = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function scanRepo(repoRoot: string): FileSize[] {
  const out: FileSize[] = [];
  for (const path of gitLsFiles(repoRoot)) {
    if (!isScannedPath(path)) continue;
    out.push({ path, lines: countLines(readFileSync(join(repoRoot, path), "utf8")) });
  }
  return out;
}

export function loadBaseline(text: string): Baseline {
  const parsed = JSON.parse(text) as Baseline;
  if (
    !parsed
    || typeof parsed !== "object"
    || !Array.isArray(parsed.generated)
    || typeof parsed.files !== "object"
    || parsed.files === null
    || Array.isArray(parsed.files)
  ) {
    throw new Error("invalid file-size baseline");
  }
  return parsed;
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function updateBaseline(current: FileSize[], baseline: Baseline, seed: boolean): Baseline {
  const now = new Map(current.map((file) => [file.path, file.lines] as const));
  const files: Record<string, number> = {};
  for (const [path, cap] of Object.entries(baseline.files)) {
    const lines = now.get(path);
    if (lines === undefined) continue;
    files[path] = Math.min(cap, lines);
  }
  if (seed) {
    const generated = new Set(baseline.generated);
    for (const [path, lines] of now) {
      if (generated.has(path) || lines < THRESHOLD || files[path] !== undefined) continue;
      files[path] = lines;
    }
  }
  return { generated: [...baseline.generated], files: sortRecord(files) };
}

export function formatOffenders(rows: Evaluation[]): string {
  return rows
    .filter(isOffender)
    .map((row) => `${row.verdict} ${row.path} ${row.lines}`)
    .join("\n");
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const baselinePath = join(repoRoot, BASELINE_REL);
  const existed = existsSync(baselinePath);
  const baseline: Baseline = existed
    ? loadBaseline(readFileSync(baselinePath, "utf8"))
    : { generated: [...GENERATED_PATHS], files: {} };
  const current = scanRepo(repoRoot);
  if (process.argv.includes("--update")) {
    const next = updateBaseline(current, baseline, !existed);
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${BASELINE_REL} (${Object.keys(next.files).length} caps)`);
    process.exit(0);
  }
  const offenders = evaluate(current, baseline).filter(isOffender);
  if (offenders.length > 0) {
    console.error("file-size ratchet failed:");
    console.error(formatOffenders(offenders));
    process.exit(1);
  }
  console.log("file-size ratchet passed");
}
