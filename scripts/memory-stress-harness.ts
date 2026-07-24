/**
 * Isolated memory-stress harness for the responses continuation store.
 *
 * WHY: OpenCodex on Bun exhibits the same "committed memory >> working set + system stutter"
 * signature that a sibling Bun CLI (Claude Code #36132) traced to the mimalloc allocator leaking
 * committed memory ~0.6-1 GB/h, independent of the JS heap. Before touching the request path we
 * need machine-local evidence that separates two hypotheses:
 *   (A) the JS-side continuation store (this repo) grows RAM, vs
 *   (B) the Bun native allocator retains memory the JS heap has already released.
 *
 * WHAT IT DOES (safe, isolated, accelerated):
 *   - Scenario "chain":    one long previous_response_id chain -> proves prefix reference sharing
 *                          (heapUsed grows ~O(N) while serialized totalBytes grows ~O(N^2)).
 *   - Scenario "sessions": many rotating independent chains with large payloads -> shows how much
 *                          RAM the current COUNT-only cap (MAX_STORED_RESPONSES) still permits.
 *   - Return-to-OS check:  clear the store + force GC, then resample RSS. If RSS does not fall,
 *                          that is the native-retention (hypothesis B) signal.
 *
 * SAFETY:
 *   - Runs the workload in a CHILD process (parent orchestrates the A/B).
 *   - Child self-aborts if its own RSS exceeds --rss-cap-mb (default 1200 MB).
 *   - Parent enforces a hard wall-clock timeout and SIGKILLs the child if it overruns.
 *   - Uses an isolated OPENCODEX_HOME temp dir so it never touches the real ~/.opencodex.
 *
 * USAGE:
 *   bun run scripts/memory-stress-harness.ts                 # parent: runs the A/B and prints a table
 *   bun run scripts/memory-stress-harness.ts --child         # single child run (used internally)
 *
 * TUNING (env, all optional):
 *   OCX_STRESS_CHAIN_TURNS, OCX_STRESS_CHAIN_PAYLOAD_BYTES,
 *   OCX_STRESS_SESSIONS, OCX_STRESS_SESSION_PAYLOAD_BYTES,
 *   OCX_STRESS_SAMPLE_EVERY, OCX_STRESS_RSS_CAP_MB, OCX_STRESS_PARENT_TIMEOUT_MS
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { captureMemorySnapshot } from "../src/lib/memory-usage";
import {
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  rememberResponseState,
  responseStateMetrics,
} from "../src/responses/state";

const MODEL = "gpt-5.5";
const MiB = 1024 * 1024;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

const CONFIG = {
  chainTurns: envInt("OCX_STRESS_CHAIN_TURNS", 400),
  chainPayloadBytes: envInt("OCX_STRESS_CHAIN_PAYLOAD_BYTES", 16 * 1024),
  sessions: envInt("OCX_STRESS_SESSIONS", 1500),
  sessionPayloadBytes: envInt("OCX_STRESS_SESSION_PAYLOAD_BYTES", 128 * 1024),
  sampleEvery: envInt("OCX_STRESS_SAMPLE_EVERY", 50),
  rssCapMb: envInt("OCX_STRESS_RSS_CAP_MB", 1200),
  parentTimeoutMs: envInt("OCX_STRESS_PARENT_TIMEOUT_MS", 120_000),
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface MemSample {
  label: string;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  storeCount: number;
  storeTotalMb: number;
  storeLargestMb: number;
}

function sample(label: string): MemSample {
  const m = process.memoryUsage();
  const s = responseStateMetrics();
  return {
    label,
    rssMb: round(m.rss / MiB),
    heapUsedMb: round(m.heapUsed / MiB),
    externalMb: round(m.external / MiB),
    storeCount: s.count,
    storeTotalMb: round(s.totalBytes / MiB),
    storeLargestMb: round(s.largestBytes / MiB),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Best-effort force GC across runtimes: Bun.gc(true), then node --expose-gc global gc(). */
function forceGc(): void {
  const bun = (globalThis as { Bun?: { gc?: (sync: boolean) => void } }).Bun;
  if (bun?.gc) bun.gc(true);
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) g();
}

function overRssCap(): boolean {
  return process.memoryUsage().rss / MiB > CONFIG.rssCapMb;
}

function makePayload(bytes: number, tag: string): string {
  // A recognizable prefix + filler; length dominates the serialized size.
  const filler = "x".repeat(Math.max(0, bytes - tag.length));
  return `${tag}${filler}`;
}

function buildTurnResponse(turnPayload: string): { id?: unknown; output?: unknown; status?: unknown } {
  return buildResponseJSON(
    [{ type: "text_delta", text: turnPayload }, { type: "done" }],
    MODEL,
  ) as { id?: unknown; output?: unknown; status?: unknown };
}

// ---------------------------------------------------------------------------
// Child role: run the workload, emit JSONL samples on stderr, SUMMARY on stdout
// ---------------------------------------------------------------------------

interface ChildSummary {
  label: string;
  aborted: boolean;
  abortReason?: string;
  chain: {
    turns: number;
    heapUsedMb: number;
    storeTotalMb: number;
    approxUniqueContentMb: number;
    // heapUsed / uniqueContent ~ 1 confirms sharing; storeTotal / heapUsed >> 1 confirms over-count.
    heapToUniqueRatio: number;
    storeToHeapRatio: number;
  };
  sessions: {
    created: number;
    peakStoreCount: number;
    peakStoreTotalMb: number;
    peakRssMb: number;
  };
  returnToOs: {
    rssBeforeClearMb: number;
    rssAfterClearGcMb: number;
    reclaimedMb: number;
  };
  /**
   * Committed-memory probe points (§7): the field signature is PRIVATE/COMMITTED >> RSS, which the
   * RSS-only columns above cannot see. Probed asynchronously at three points only (each Windows
   * probe spawns a child, ~4-6s on a slow box) — start, before clear, after clear+GC. HONEST
   * LIMIT: these columns verify the pattern is DETECTABLE on this machine; a passing run does not
   * prove the leak cannot recur.
   */
  committed: {
    available: boolean; // false on non-Windows (v1) or probe failure
    source: string;
    startPrivateMb: number | null;
    beforeClearPrivateMb: number | null;
    afterClearPrivateMb: number | null;
    afterClearRssMb: number;
    /** Private/RSS after clear+GC — >> 1 is the native-retention (hypothesis B) detectability signal. */
    afterClearPrivateToRssRatio: number | null;
    systemCommittedMb: number | null;
    systemCommitLimitMb: number | null;
    systemCommitFraction: number | null;
  };
}

function emitSample(s: MemSample): void {
  process.stderr.write(JSON.stringify({ kind: "sample", ...s }) + "\n");
}

interface CommittedProbe {
  privateMb: number | null;
  systemCommittedMb: number | null;
  systemCommitLimitMb: number | null;
  available: boolean;
  source: string;
}

async function probeCommitted(label: string): Promise<CommittedProbe> {
  const snap = await captureMemorySnapshot();
  const probe: CommittedProbe = {
    privateMb: snap.processPrivateBytes === null ? null : round(snap.processPrivateBytes / MiB),
    systemCommittedMb: snap.systemCommittedBytes === null ? null : round(snap.systemCommittedBytes / MiB),
    systemCommitLimitMb: snap.systemCommitLimitBytes === null ? null : round(snap.systemCommitLimitBytes / MiB),
    available: snap.systemCommitAvailable,
    source: snap.processSource,
  };
  process.stderr.write(JSON.stringify({ kind: "probe", label, ...probe }) + "\n");
  return probe;
}

async function runChild(): Promise<void> {
  const label = process.env["OCX_STRESS_LABEL"] ?? "child";
  const summary: ChildSummary = {
    label,
    aborted: false,
    chain: {
      turns: 0, heapUsedMb: 0, storeTotalMb: 0, approxUniqueContentMb: 0,
      heapToUniqueRatio: 0, storeToHeapRatio: 0,
    },
    sessions: { created: 0, peakStoreCount: 0, peakStoreTotalMb: 0, peakRssMb: 0 },
    returnToOs: { rssBeforeClearMb: 0, rssAfterClearGcMb: 0, reclaimedMb: 0 },
    committed: {
      available: false, source: "rss-fallback",
      startPrivateMb: null, beforeClearPrivateMb: null, afterClearPrivateMb: null,
      afterClearRssMb: 0, afterClearPrivateToRssRatio: null,
      systemCommittedMb: null, systemCommitLimitMb: null, systemCommitFraction: null,
    },
  };

  const startProbe = await probeCommitted("start");

  // --- Scenario A: one long chain (prefix reference sharing / C-type proof) ---
  clearResponseStateMemoryForTests();
  forceGc();
  let prevId: string | undefined;
  let turn = 0;
  for (turn = 1; turn <= CONFIG.chainTurns; turn++) {
    const payload = makePayload(CONFIG.chainPayloadBytes, `chain-t${turn}-`);
    const body = prevId
      ? { model: MODEL, previous_response_id: prevId, input: [{ role: "user", content: payload }], store: false }
      : { model: MODEL, input: [{ role: "user", content: payload }], store: false };
    const expanded = expandPreviousResponseInput(body);
    const resp = buildTurnResponse(payload);
    rememberResponseState(expanded, resp, undefined, { force: true });
    prevId = resp.id as string;
    if (turn % CONFIG.sampleEvery === 0) {
      emitSample(sample(`chain@${turn}`));
      if (overRssCap()) {
        summary.aborted = true;
        summary.abortReason = `RSS cap ${CONFIG.rssCapMb}MB exceeded during chain at turn ${turn}`;
        break;
      }
    }
  }
  forceGc();
  {
    const s = sample(`chain-final@${turn}`);
    emitSample(s);
    // Unique content is created once per turn (input payload + output text of ~equal size), then
    // shared by reference across every later entry: ~ 2 * turns * payload.
    const approxUniqueContentMb = round((2 * (turn) * CONFIG.chainPayloadBytes) / MiB);
    summary.chain = {
      turns: turn,
      heapUsedMb: s.heapUsedMb,
      storeTotalMb: s.storeTotalMb,
      approxUniqueContentMb,
      heapToUniqueRatio: approxUniqueContentMb > 0 ? round(s.heapUsedMb / approxUniqueContentMb) : 0,
      storeToHeapRatio: s.heapUsedMb > 0 ? round(s.storeTotalMb / s.heapUsedMb) : 0,
    };
  }

  if (!summary.aborted) {
    // --- Scenario B: many rotating independent sessions with large payloads ---
    clearResponseStateMemoryForTests();
    forceGc();
    for (let i = 1; i <= CONFIG.sessions; i++) {
      const payload = makePayload(CONFIG.sessionPayloadBytes, `sess-${i}-`);
      const body = { model: MODEL, input: [{ role: "user", content: payload }], store: false };
      const resp = buildTurnResponse(payload);
      rememberResponseState(body, resp, undefined, { force: true });
      summary.sessions.created = i;
      if (i % CONFIG.sampleEvery === 0) {
        const s = sample(`sessions@${i}`);
        emitSample(s);
        summary.sessions.peakStoreCount = Math.max(summary.sessions.peakStoreCount, s.storeCount);
        summary.sessions.peakStoreTotalMb = Math.max(summary.sessions.peakStoreTotalMb, s.storeTotalMb);
        summary.sessions.peakRssMb = Math.max(summary.sessions.peakRssMb, s.rssMb);
        if (overRssCap()) {
          summary.aborted = true;
          summary.abortReason = `RSS cap ${CONFIG.rssCapMb}MB exceeded during sessions at ${i}`;
          break;
        }
      }
    }
  }

  // --- Return-to-OS check: clear + GC, then see if RSS (and Private) actually fall ---
  const beforeClearProbe = await probeCommitted("before-clear");
  const rssBeforeClear = round(process.memoryUsage().rss / MiB);
  clearResponseStateMemoryForTests();
  forceGc();
  // Give the allocator a beat to purge.
  await new Promise(resolve => setTimeout(resolve, 250));
  forceGc();
  const rssAfterClearGc = round(process.memoryUsage().rss / MiB);
  summary.returnToOs = {
    rssBeforeClearMb: rssBeforeClear,
    rssAfterClearGcMb: rssAfterClearGc,
    reclaimedMb: round(rssBeforeClear - rssAfterClearGc),
  };

  // The detectability signal for the field incident: committed/private staying high after the JS
  // heap released everything, i.e. Private >> RSS post-clear.
  const afterClearProbe = await probeCommitted("after-clear-gc");
  summary.committed = {
    available: afterClearProbe.available || beforeClearProbe.available || startProbe.available,
    source: afterClearProbe.source,
    startPrivateMb: startProbe.privateMb,
    beforeClearPrivateMb: beforeClearProbe.privateMb,
    afterClearPrivateMb: afterClearProbe.privateMb,
    afterClearRssMb: rssAfterClearGc,
    afterClearPrivateToRssRatio: afterClearProbe.privateMb !== null && rssAfterClearGc > 0
      ? round(afterClearProbe.privateMb / rssAfterClearGc)
      : null,
    systemCommittedMb: afterClearProbe.systemCommittedMb,
    systemCommitLimitMb: afterClearProbe.systemCommitLimitMb,
    systemCommitFraction: afterClearProbe.systemCommittedMb !== null && afterClearProbe.systemCommitLimitMb !== null && afterClearProbe.systemCommitLimitMb > 0
      ? round(afterClearProbe.systemCommittedMb / afterClearProbe.systemCommitLimitMb)
      : null,
  };

  process.stdout.write("SUMMARY " + JSON.stringify(summary) + "\n");
}

// ---------------------------------------------------------------------------
// Parent role: orchestrate the A/B, enforce timeout, print a comparison table
// ---------------------------------------------------------------------------

interface Overlay { label: string; env: Record<string, string>; }

function runParent(): void {
  const home = mkdtempSync(join(tmpdir(), "ocx-stress-"));
  // A/B overlays. The mimalloc knobs are best-effort: if Bun's bundled mimalloc ignores them the
  // two rows will simply match, which is itself informative (rules the lever out).
  const overlays: Overlay[] = [
    { label: "bun-default", env: {} },
    { label: "mimalloc-purge0", env: { MIMALLOC_PURGE_DELAY: "0", MIMALLOC_PAGE_RESET: "1" } },
  ];

  console.log("== OpenCodex memory-stress harness ==");
  console.log(`bun: ${process.versions?.bun ?? "?"}  node-compat: ${process.version}  platform: ${process.platform}`);
  console.log("config:", JSON.stringify(CONFIG));
  console.log(`isolated OPENCODEX_HOME: ${home}`);
  console.log("");

  const summaries: ChildSummary[] = [];
  for (const overlay of overlays) {
    process.stdout.write(`-- running scenario [${overlay.label}] ...\n`);
    const res = spawnSync(
      process.execPath,
      [__filename, "--child"],
      {
        env: {
          ...process.env,
          ...overlay.env,
          OPENCODEX_HOME: home,
          OCX_STRESS_LABEL: overlay.label,
        },
        timeout: CONFIG.parentTimeoutMs,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 64 * MiB,
      },
    );
    if (res.error) {
      console.log(`   [${overlay.label}] spawn error: ${res.error.message}`);
      continue;
    }
    if (res.signal) {
      console.log(`   [${overlay.label}] killed by ${res.signal} (likely parent timeout / safety)`);
    }
    const summary = parseSummary(res.stdout ?? "");
    if (summary) summaries.push(summary);
    else console.log(`   [${overlay.label}] no SUMMARY produced. stderr tail:\n${tail(res.stderr ?? "", 5)}`);
  }

  rmSync(home, { recursive: true, force: true });
  printReport(summaries);
}

function parseSummary(stdout: string): ChildSummary | null {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("SUMMARY ")) {
      try { return JSON.parse(line.slice("SUMMARY ".length)) as ChildSummary; } catch { return null; }
    }
  }
  return null;
}

function tail(text: string, lines: number): string {
  return text.split("\n").filter(Boolean).slice(-lines).join("\n");
}

function printReport(summaries: ChildSummary[]): void {
  console.log("\n================= RESULTS =================\n");
  for (const s of summaries) {
    console.log(`### scenario: ${s.label}${s.aborted ? "  (ABORTED: " + s.abortReason + ")" : ""}`);
    console.log("  chain (prefix-sharing / C-type):");
    console.log(`    turns=${s.chain.turns}  heapUsed=${s.chain.heapUsedMb}MB  storeTotal=${s.chain.storeTotalMb}MB  approxUniqueContent=${s.chain.approxUniqueContentMb}MB`);
    console.log(`    heapUsed/uniqueContent=${s.chain.heapToUniqueRatio} (~1 => content shared by reference)`);
    console.log(`    storeTotal/heapUsed=${s.chain.storeToHeapRatio} (>>1 => serialized metric over-counts shared prefixes)`);
    console.log("  sessions (count-only cap headroom):");
    console.log(`    created=${s.sessions.created}  peakStoreCount=${s.sessions.peakStoreCount}  peakStoreTotal=${s.sessions.peakStoreTotalMb}MB  peakRss=${s.sessions.peakRssMb}MB`);
    console.log("  return-to-OS (native-retention signal):");
    console.log(`    rssBeforeClear=${s.returnToOs.rssBeforeClearMb}MB  rssAfterClear+GC=${s.returnToOs.rssAfterClearGcMb}MB  reclaimed=${s.returnToOs.reclaimedMb}MB`);
    console.log("  committed probes (Private>>RSS detectability; NOT a non-regression proof):");
    if (s.committed.available) {
      console.log(`    private: start=${s.committed.startPrivateMb}MB  beforeClear=${s.committed.beforeClearPrivateMb}MB  afterClear+GC=${s.committed.afterClearPrivateMb}MB`);
      console.log(`    afterClear private/RSS=${s.committed.afterClearPrivateToRssRatio} (>>1 => committed retained past the JS release)`);
      console.log(`    system commit: ${s.committed.systemCommittedMb}MB / ${s.committed.systemCommitLimitMb}MB (fraction=${s.committed.systemCommitFraction})`);
    } else {
      console.log(`    unavailable on this platform/run (source=${s.committed.source}) — RSS-only columns above still apply`);
    }
    console.log("");
  }
  if (summaries.length >= 2) {
    const [a, b] = summaries;
    console.log("### A/B (allocator lever)");
    console.log(`    ${a.label} peakRss=${a.sessions.peakRssMb}MB reclaimed=${a.returnToOs.reclaimedMb}MB`);
    console.log(`    ${b.label} peakRss=${b.sessions.peakRssMb}MB reclaimed=${b.returnToOs.reclaimedMb}MB`);
    console.log("    (if reclaimed is small in BOTH, RSS is retained after JS release => hypothesis B / native allocator)");
  }
  console.log("\n=========================================");
  console.log("Interpretation guide:");
  console.log("  - heapUsed/uniqueContent ~ 1  => items are shared by reference; a delta-chain refactor buys little.");
  console.log("  - storeTotal/heapUsed >> 1    => the JSON-serialized byte metric over-counts (upper bound), as designed.");
  console.log("  - sessions peakRss high with peakStoreCount pinned at the count cap => a BYTE budget would help (hygiene).");
  console.log("  - reclaimed ~ 0 after clear+GC => native retention dominates => the fix is a watchdog + preemptive restart.");
  console.log("  - afterClear private/RSS >> 1  => the committed>>RSS field signature is DETECTABLE here (the watchdog's");
  console.log("    windows-private source would see it). A clean run does NOT prove the leak cannot recur.");
}

// ---------------------------------------------------------------------------

if (process.argv.includes("--child")) {
  await runChild();
} else {
  runParent();
}
