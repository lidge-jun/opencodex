/**
 * smol-worker A/B gate (devlog/_plan/260822_260822-bun14-followup-memory/030).
 *
 * Synthetic SCREENING of whether Worker({ smol: true }) reduces peak RSS on the
 * burst shape the production workers share: materialize many rows into arrays,
 * then serialize one aggregate JSON. It does NOT import history-provider,
 * restore-job, or policy-job, so a verdict here screens that shared shape — it
 * is not a per-call-site gate for any individual worker.
 *
 * Isolation: every run is a FRESH child process (in-process sequential runs
 * contaminate baselines — the allocator retains pages across runs, which the
 * first version of this script measured as a phantom smol win). The child runs
 * the workload in a real Worker thread and exits; the parent reads the child's
 * peak RSS from Subprocess.resourceUsage().maxRSS.
 *
 * Acceptance (audited gate): completion success, elapsed within +25% of
 * baseline, peak RSS reduced.
 *
 * Usage: bun scripts/smol-worker-ab.ts <outDir> [payloadMb] [runs]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: bun scripts/smol-worker-ab.ts <outDir> [payloadMb] [runs]");

/**
 * A memory-stress script takes explicit, bounded inputs. Unvalidated arguments
 * let `runs=0` write a report whose gate claims completionSuccess over an empty
 * result set, and let a negative or absurd payload run a meaningless workload or
 * exhaust the host. Refuse instead of measuring nothing.
 */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in ${min}..${max} (received ${JSON.stringify(raw)})`);
  }
  return parsed;
}
const PAYLOAD_MB = boundedInt(process.argv[3], 100, 1, 512, "payloadMb");
const RUNS = boundedInt(process.argv[4], 3, 1, 20, "runs");
mkdirSync(outDir, { recursive: true });

/** Child body: runs the audited workload shape inside a real Worker, prints elapsed. */
const childSource = "const smol = process.argv[2] === \"smol\";\nconst payloadMb = Number.parseInt(process.argv[3] ?? \"100\", 10);\nconst workerSource = \"self.onmessage = (event) => {\\n  const { payloadMb } = event.data;\\n  const t0 = performance.now();\\n  try {\\n    const ROW_BYTES = 4096;\\n    const rowCount = Math.floor((payloadMb * 1024 * 1024) / ROW_BYTES);\\n    const rows = [];\\n    for (let i = 0; i < rowCount; i++) {\\n      rows.push({\\n        id: \\\"row-\\\" + i,\\n        kind: i % 3 === 0 ? \\\"thread\\\" : i % 3 === 1 ? \\\"log\\\" : \\\"memory\\\",\\n        payload: \\\"x\\\".repeat(ROW_BYTES - 96),\\n        at: Date.now(),\\n      });\\n    }\\n    const backup = JSON.stringify({ rows });\\n    self.postMessage({ type: \\\"done\\\", rowCount, bytes: backup.length, elapsedMs: performance.now() - t0 });\\n  } catch (error) {\\n    self.postMessage({ type: \\\"error\\\", message: String(error), elapsedMs: performance.now() - t0 });\\n  }\\n};\";\nconst url = URL.createObjectURL(new Blob([workerSource], { type: \"application/javascript\" }));\nconst worker = new Worker(url, smol ? { smol: true } : {});\nconst outcome = await new Promise((resolve, reject) => {\n  const timeout = setTimeout(() => reject(new Error(\"worker timeout (120s)\")), 120_000);\n  worker.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };\n  worker.onerror = (event) => { clearTimeout(timeout); reject(new Error(event.message || \"worker error\")); };\n  worker.postMessage({ payloadMb });\n});\nworker.terminate();\nconsole.log(JSON.stringify(outcome));";

const childPath = join(outDir, "ab-child.ts");
writeFileSync(childPath, childSource);

type RunResult = {
  smol: boolean;
  runIndex: number;
  ok: boolean;
  elapsedMs: number;
  maxRssBytes: number;
  error?: string;
};

async function oneRun(smol: boolean, runIndex: number): Promise<RunResult> {
  const child = Bun.spawn([process.execPath, childPath, smol ? "smol" : "full", String(PAYLOAD_MB)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const usage = child.resourceUsage();
  // Bun reports maxRSS in bytes on darwin (ru_maxrss is bytes on macOS, KiB on Linux;
  // Bun.resourceUsage normalizes to bytes).
  const maxRssBytes = usage?.maxRSS ?? -1;
  let elapsedMs = -1;
  let ok = false;
  let error: string | undefined;
  try {
    const line = stdout.trim().split(/\r?\n/).pop() ?? "";
    const parsed = JSON.parse(line) as { type: string; elapsedMs: number; message?: string };
    ok = exitCode === 0 && parsed.type === "done";
    elapsedMs = parsed.elapsedMs;
    error = parsed.message;
  } catch {
    error = "unparseable child output; exit " + exitCode + "; stderr: " + stderr.slice(0, 200);
  }
  return { smol, runIndex, ok, elapsedMs, maxRssBytes, ...(error ? { error } : {}) };
}

const results: RunResult[] = [];
for (let run = 0; run < RUNS; run++) {
  for (const smol of [false, true]) {
    const r = await oneRun(smol, run);
    results.push(r);
    console.log(JSON.stringify(r));
  }
}

function median(values: number[]): number {
  // An empty arm has no median. Returning undefined here would silently become
  // NaN in the gate; the caller must not ask until it has a complete arm.
  if (values.length === 0) throw new Error("median of an empty result set");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const off = results.filter(r => !r.smol && r.ok);
const on = results.filter(r => r.smol && r.ok);
const gate = {
  completionSuccess: RUNS > 0 && on.length === RUNS && off.length === RUNS,
  medianElapsedOffMs: null as number | null,
  medianElapsedOnMs: null as number | null,
  medianMaxRssOffBytes: null as number | null,
  medianMaxRssOnBytes: null as number | null,
  elapsedWithin25Pct: false,
  peakRssReduced: false,
  verdict: "fail" as "pass" | "fail",
};
if (gate.completionSuccess) {
  // Medians are computed only once both arms are complete, so the gate can never
  // report a verdict derived from a partial or empty run set.
  gate.medianElapsedOffMs = median(off.map(r => r.elapsedMs));
  gate.medianElapsedOnMs = median(on.map(r => r.elapsedMs));
  gate.medianMaxRssOffBytes = median(off.map(r => r.maxRssBytes));
  gate.medianMaxRssOnBytes = median(on.map(r => r.maxRssBytes));
  gate.elapsedWithin25Pct = gate.medianElapsedOnMs <= gate.medianElapsedOffMs * 1.25;
  gate.peakRssReduced = gate.medianMaxRssOnBytes < gate.medianMaxRssOffBytes;
  gate.verdict = gate.elapsedWithin25Pct && gate.peakRssReduced ? "pass" : "fail";
}

const report = {
  bunVersion: Bun.version,
  bunRevision: Bun.revision,
  platform: process.platform,
  arch: process.arch,
  at: new Date().toISOString(),
  payloadMb: PAYLOAD_MB,
  runs: RUNS,
  isolation: "fresh child process per run; peak = Subprocess.resourceUsage().maxRSS",
  results,
  gate,
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(gate));
console.log("report: " + join(outDir, "report.json"));
