export interface MemoryRecallSoakOptions {
  seed: number;
  sustainedSessions: number;
  sustainedRounds: number;
  sustainedWaves: number;
  burstSessions: number;
  burstRounds: number;
  faultSessions: number;
  slowConsumerPercent: number;
  cancelPercent: number;
  idleDeadlineMs: number;
  sampleIntervalMs: number;
}

export const DEFAULT_MEMORY_RECALL_SOAK_OPTIONS: MemoryRecallSoakOptions = {
  seed: 820_001,
  sustainedSessions: 32,
  sustainedRounds: 10,
  sustainedWaves: 3,
  burstSessions: 64,
  burstRounds: 1,
  faultSessions: 32,
  slowConsumerPercent: 25,
  cancelPercent: 25,
  idleDeadlineMs: 30_000,
  sampleIntervalMs: 100,
};

const QUICK_MEMORY_RECALL_SOAK_OPTIONS: MemoryRecallSoakOptions = {
  ...DEFAULT_MEMORY_RECALL_SOAK_OPTIONS,
  sustainedSessions: 4,
  sustainedRounds: 2,
  sustainedWaves: 2,
  burstSessions: 8,
  faultSessions: 8,
  idleDeadlineMs: 10_000,
  sampleIntervalMs: 50,
};

const INTEGER_FLAGS: ReadonlyArray<{
  flag: string;
  key: keyof MemoryRecallSoakOptions;
  min: number;
  max: number;
}> = [
  { flag: "--seed", key: "seed", min: 0, max: 0xffff_ffff },
  { flag: "--sessions", key: "sustainedSessions", min: 1, max: 96 },
  { flag: "--rounds", key: "sustainedRounds", min: 1, max: 100 },
  { flag: "--waves", key: "sustainedWaves", min: 2, max: 20 },
  { flag: "--burst-sessions", key: "burstSessions", min: 1, max: 96 },
  { flag: "--burst-rounds", key: "burstRounds", min: 1, max: 20 },
  { flag: "--fault-sessions", key: "faultSessions", min: 0, max: 96 },
  { flag: "--slow-percent", key: "slowConsumerPercent", min: 0, max: 100 },
  { flag: "--cancel-percent", key: "cancelPercent", min: 0, max: 100 },
  { flag: "--idle-deadline-ms", key: "idleDeadlineMs", min: 1_000, max: 120_000 },
  { flag: "--sample-interval-ms", key: "sampleIntervalMs", min: 25, max: 5_000 },
];

export function memoryRecallSoakUsage(): string {
  return [
    "Usage: bun scripts/memory-recall-soak.ts [options]",
    "",
    "Offline #820 acceptance/profiling probe. It starts an isolated OpenCodex child",
    "against a local mock provider and emits payload-free JSON metrics.",
    "",
    "Options:",
    "  --quick                 Small deterministic smoke profile",
    "  --seed N                Deterministic workload seed",
    "  --sessions N            Sustained independent sessions (default 32)",
    "  --rounds N              Recall rounds per sustained session (default 10)",
    "  --waves N               Identical sustained waves (default 3)",
    "  --burst-sessions N      Independent burst sessions (default 64)",
    "  --burst-rounds N        Recall rounds in the burst (default 1)",
    "  --fault-sessions N      Fault/cancel probe sessions (default 32)",
    "  --slow-percent N        Slow-consumer share, 0..100 (default 25)",
    "  --cancel-percent N      Fault-wave cancellation share, 0..100 (default 25)",
    "  --idle-deadline-ms N    Cleanup invariant deadline (default 30000)",
    "  --sample-interval-ms N  Child-memory sample cadence (default 100)",
    "  --help                   Show this help",
  ].join("\n");
}

export function parseMemoryRecallSoakOptions(args: readonly string[]): MemoryRecallSoakOptions {
  const options = args.includes("--quick")
    ? { ...QUICK_MEMORY_RECALL_SOAK_OPTIONS }
    : { ...DEFAULT_MEMORY_RECALL_SOAK_OPTIONS };
  const knownFlags = new Set<string>(["--quick", "--help", ...INTEGER_FLAGS.map(row => row.flag)]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) throw new Error(`unexpected positional argument: ${arg}`);
    if (!knownFlags.has(arg)) throw new Error(`unknown option: ${arg}`);
    if (arg === "--quick" || arg === "--help") continue;

    const spec = INTEGER_FLAGS.find(row => row.flag === arg);
    if (!spec) continue;
    const raw = args[index + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error(`${arg} requires an integer value`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
      throw new Error(`${arg} must be an integer in ${spec.min}..${spec.max}`);
    }
    options[spec.key] = value;
    index += 1;
  }

  return options;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function stableHash(text: string, seed = 0): number {
  let hash = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deterministicToolCount(sessionId: string, round: number, seed: number): number {
  return 1 + (stableHash(`${sessionId}:${round}`, seed) % 8);
}

export function deterministicPercent(sessionId: string, salt: string, seed: number): number {
  return stableHash(`${salt}:${sessionId}`, seed) % 100;
}

export function linearSlope(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const count = values.length;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < count; index++) {
    const dx = index - meanX;
    numerator += dx * (values[index] - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? null : numerator / denominator;
}

export function maxFinite(values: readonly number[]): number | null {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value) && value > maximum) maximum = value;
  }
  return maximum === Number.NEGATIVE_INFINITY ? null : maximum;
}
