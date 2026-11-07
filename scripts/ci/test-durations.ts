/**
 * Per-file Bun test durations for shard assignment.
 *
 * `scripts/ci/run-bun-test-batches.sh` weighs every test file by the milliseconds recorded for it in
 * `scripts/ci/test-durations.tsv` and assigns the heaviest file first to the least-loaded shard. This
 * tool keeps that table honest by reading it back from hosted CI job logs, where every line carries
 * a runner timestamp and Bun wraps each file's output in its own `##[group]<file>:` ...
 * `##[endgroup]` pair. A file's duration is the time from the previous file's end (or its batch
 * header, for the first file of a process) to its own end, so process start and module loading are
 * charged to the file that caused them.
 *
 * Two tables are kept. Linux and macOS shards share `test-durations.tsv`; Windows shards weigh files
 * with `test-durations.windows.tsv`, which the batch runner selects when RUNNER_OS is Windows. Per-file
 * cost on Windows is not a constant multiple of the other two, so one table balanced either Linux and
 * macOS or Windows, never all three (#6982). A file measured in several logs records the mean of its
 * samples, which is why each table reads only its own platforms' logs.
 *
 * Refresh both from one green `lane=all` dispatch on dev. `gh run view --log` refuses a run this
 * large, so read one job at a time:
 *
 *   gh run view <run-id> --job <job-id> --log > .tmp/<job>.log            (every suite shard)
 *   bun scripts/ci/test-durations.ts refresh --source "run <run-id>, ..." <test N/4 and macos N/4 logs>
 *   bun scripts/ci/test-durations.ts refresh --table scripts/ci/test-durations.windows.tsv \
 *     --source "run <run-id>, ..." <windows N/9 logs>
 *
 * Windows shards print their group headers with backslashes (`tests\a\b.test.ts:`); those paths are
 * stored with forward slashes, the form `run-bun-test-batches.sh` looks up.
 *
 * Files measured in the logs replace their rows; rows for files that still exist are kept; rows for
 * files that no longer exist are dropped. Attribution sweeps (a failed shard re-running files one at a
 * time) are ignored because they do not measure the batch shape the table is used for.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const DURATIONS_TABLE = join(REPO_ROOT, "scripts", "ci", "test-durations.tsv");
export const WINDOWS_DURATIONS_TABLE = join(REPO_ROOT, "scripts", "ci", "test-durations.windows.tsv");

const LOG_LINE = /^(?:(.*?)\t[^\t]*\t)?\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z (.*)$/;
const BATCH_HEADER = /^##\[group\]shard \S+ batch \d+\/\d+(.*)$/;
const FILE_HEADER = /^##\[group\](tests[\\/].+):$/;
const ANSI = /\u001b\[[0-9;]*m/g;

function timestampMs(seconds: string, fraction: string | undefined): number {
  const milliseconds = (fraction ?? ".0").slice(1, 4).padEnd(3, "0");
  return Date.parse(`${seconds}.${milliseconds}Z`);
}

/** Every measured duration per file, in milliseconds, from one or more concatenated job logs. */
export function parseJobLog(text: string): Map<string, number[]> {
  type JobState = { previousEnd: number | null; file: string | null; attribution: boolean };
  const jobs = new Map<string, JobState>();
  const samples = new Map<string, number[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const match = LOG_LINE.exec(rawLine.replace(ANSI, ""));
    if (!match) continue;
    const job = match[1] ?? "";
    const at = timestampMs(match[2]!, match[3]);
    const body = match[4]!;
    let state = jobs.get(job);
    if (!state) {
      state = { previousEnd: null, file: null, attribution: false };
      jobs.set(job, state);
    }
    const batch = BATCH_HEADER.exec(body);
    if (batch) {
      state.previousEnd = at;
      state.file = null;
      state.attribution = batch[1]!.includes("attribution");
      continue;
    }
    const file = FILE_HEADER.exec(body);
    if (file) {
      state.file = state.attribution || state.previousEnd === null ? null : file[1]!.replaceAll("\\", "/");
      continue;
    }
    if (body.startsWith("##[endgroup]") && state.file !== null && state.previousEnd !== null) {
      const list = samples.get(state.file) ?? [];
      list.push(Math.max(0, at - state.previousEnd));
      samples.set(state.file, list);
      state.previousEnd = at;
      state.file = null;
    }
  }
  return samples;
}

/** The recorded table, path -> milliseconds. Comment lines and malformed rows are ignored. */
export function parseTable(text: string): Map<string, number> {
  const table = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length !== 2 || !/^\d+$/.test(fields[0]!)) continue;
    table.set(fields[1]!, Number(fields[0]));
  }
  return table;
}

/** New measurements win; kept rows must still name a file; every duration is at least 1 ms. */
export function mergeDurations(
  previous: ReadonlyMap<string, number>,
  measured: ReadonlyMap<string, readonly number[]>,
  exists: (path: string) => boolean,
): Map<string, number> {
  const merged = new Map<string, number>();
  for (const [path, value] of previous) if (exists(path)) merged.set(path, value);
  for (const [path, values] of measured) {
    if (!exists(path) || values.length === 0) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    merged.set(path, Math.max(1, Math.round(mean)));
  }
  return merged;
}

export function renderTable(durations: ReadonlyMap<string, number>, source: string): string {
  const rows = [...durations.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, value]) => `${value}\t${path}`);
  return [
    "# Per-file Bun test durations in milliseconds, read from hosted CI job logs.",
    "# Consumed by scripts/ci/run-bun-test-batches.sh to balance shards; a file without a row weighs the median.",
    "# Regenerate with scripts/ci/test-durations.ts (usage in its header); do not edit by hand.",
    `# Source: ${source}`,
    ...rows,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  let source = "unspecified";
  let table = DURATIONS_TABLE;
  const logs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--source") source = rest[++index] ?? source;
    else if (rest[index] === "--table") table = resolve(rest[++index] ?? table);
    else logs.push(rest[index]!);
  }
  if (command !== "refresh" || logs.length === 0) {
    console.error("usage: bun scripts/ci/test-durations.ts refresh [--table <tsv>] [--source <text>] <job-log>...");
    process.exit(64);
  }
  const measured = new Map<string, number[]>();
  for (const log of logs) {
    for (const [path, values] of parseJobLog(readFileSync(log, "utf8"))) {
      measured.set(path, [...(measured.get(path) ?? []), ...values]);
    }
  }
  if (measured.size === 0) {
    console.error("No per-file durations found; pass hosted logs of the suite shards.");
    process.exit(1);
  }
  const previous = existsSync(table) ? parseTable(readFileSync(table, "utf8")) : new Map<string, number>();
  const merged = mergeDurations(previous, measured, path => existsSync(join(REPO_ROOT, path)));
  writeFileSync(table, renderTable(merged, source));
  console.log(`Recorded ${merged.size} files (${measured.size} measured) in ${table}.`);
}
