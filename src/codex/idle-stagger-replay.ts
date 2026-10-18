/** Pure, synthetic-only trace evaluator for #7206 PR A. No I/O or clocks. */
export type Availability = "usable" | "unusable" | "unknown";
export interface Observation { atMs: number; accounts: Readonly<Record<string, Availability>> }
export interface ReplayTrace { name: string; startMs: number; endMs: number; observations: readonly Observation[] }
export interface ReplayMetrics {
  traceName: string;
  elapsedMs: number;
  anyKnownUsableMs: number;
  allKnownUnusableMs: number;
  unknownCoverageMs: number;
  unknownAccountMs: number;
}
const safe = (x: number) => Number.isSafeInteger(x) && x >= 0;
/** Unknown never counts as unusable; simultaneous availability remains separately measurable. */
export function evaluateTrace(trace: ReplayTrace): ReplayMetrics {
  if (!safe(trace.startMs) || !safe(trace.endMs) || trace.endMs <= trace.startMs
    || trace.observations.length === 0 || trace.observations.length > 10_000) throw Error("invalid trace bounds");
  const initialKeys = Object.keys(trace.observations[0].accounts).sort();
  if (initialKeys.length === 0 || initialKeys.length > 1024) throw Error("invalid trace cohort");
  let cursor = trace.startMs;
  let anyKnownUsableMs = 0;
  let allKnownUnusableMs = 0;
  let unknownCoverageMs = 0;
  let unknownAccountMs = 0;
  for (let i=0;i<trace.observations.length;i++) {
    const item=trace.observations[i];
    if (item.atMs !== cursor || Object.keys(item.accounts).sort().join("\0") !== initialKeys.join("\0")) throw Error("noncontiguous trace or changing cohort");
    if (Object.values(item.accounts).some(s => !["usable","unusable","unknown"].includes(s))) throw Error("bad availability");
    const end = i+1<trace.observations.length ? trace.observations[i+1].atMs : trace.endMs;
    if (!safe(end) || end <= cursor || end > trace.endMs) throw Error("bad trace ordering");
    const duration = end - cursor;
    const statuses = Object.values(item.accounts);
    if (statuses.includes("usable")) anyKnownUsableMs += duration;
    else if (statuses.includes("unknown")) unknownCoverageMs += duration;
    else allKnownUnusableMs += duration;
    unknownAccountMs += duration * statuses.filter(x => x === "unknown").length;
    cursor=end;
  }
  return {traceName:trace.name,elapsedMs:trace.endMs-trace.startMs,anyKnownUsableMs,allKnownUnusableMs,
    unknownCoverageMs,unknownAccountMs};
}
/** Pair baselines: report separate metrics, do not claim extrapolation to real upstream. */
export function compareTraceFixtures(traces: readonly ReplayTrace[]): ReplayMetrics[] {
  if (traces.length !== 3 || new Set(traces.map(x => x.name)).size !== 3
    || !["passive","legacy","offline-policy"].every(x => traces.some(t=>t.name===x))) throw Error("paired baselines required");
  const [first] = traces;
  if (traces.some(t=>t.startMs!==first.startMs || t.endMs!==first.endMs
    || Object.keys(t.observations[0].accounts).sort().join("\0") !== Object.keys(first.observations[0].accounts).sort().join("\0"))) throw Error("non-comparable fixture cohorts");
  return traces.map(evaluateTrace);
}
