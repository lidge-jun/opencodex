/**
 * RSS memory watchdog (#314 WP3) — warn-only observability for the Windows
 * native-memory growth reported upstream (Bun fetch buffers / socket handles).
 *
 * Samples process.memoryUsage() on an unref'd interval into a bounded ring and
 * logs ONE rate-limited warning when RSS crosses the threshold. It never
 * restarts anything (threshold auto-restart is deliberately deferred; the
 * service managers' crash-respawn already covers hard failures). The active
 * instance is a module-level singleton so the management API can expose the
 * snapshot without threading server state through route contexts.
 *
 * Privacy: samples are scalar numbers only; the warn line never interpolates
 * paths, hostnames, or tokens.
 */

export type MemorySample = {
  /** Epoch ms. */
  at: number;
  /** Resident set size in bytes. */
  rss: number;
  /** JS heap used in bytes (process.memoryUsage().heapUsed). */
  heapUsed: number;
  /** JS heap total in bytes. */
  heapTotal: number;
};

export type MemoryWatchdogState = {
  samples: MemorySample[];
  warnThresholdBytes: number;
  lastWarnAt: number | null;
};

export type MemoryWatchdog = {
  stop(): void;
  snapshot(): MemoryWatchdogState;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_THRESHOLD_BYTES = 4 * 1024 ** 3; // 4 GiB
const DEFAULT_RING_SIZE = 360; // ≈6h at 60s
const WARN_INTERVAL_MS = 30 * 60_000;
const DOCS_URL = "https://lidge-jun.github.io/opencodex/troubleshooting/windows-memory/";

let active: MemoryWatchdog | null = null;

/** The running watchdog, if any — read by /api/system/memory. */
export function getActiveMemoryWatchdog(): MemoryWatchdog | null {
  return active;
}

function defaultSample(now: () => number): MemorySample {
  const usage = process.memoryUsage();
  return { at: now(), rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal };
}

/**
 * Start (or replace) the process-wide memory watchdog. Idempotent: a previous
 * active instance is stopped first, so repeated startServer() calls in tests
 * never accumulate intervals. The timer is unref'd; stop() is exposed for
 * tests and clears the singleton.
 */
export function startMemoryWatchdog(opts?: {
  intervalMs?: number;
  warnThresholdBytes?: number;
  ringSize?: number;
  now?: () => number;
  sample?: () => MemorySample;
  warn?: (msg: string) => void;
}): MemoryWatchdog {
  active?.stop();
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const warnThresholdBytes = opts?.warnThresholdBytes ?? DEFAULT_WARN_THRESHOLD_BYTES;
  const ringSize = opts?.ringSize ?? DEFAULT_RING_SIZE;
  const now = opts?.now ?? Date.now;
  const sample = opts?.sample ?? (() => defaultSample(now));
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));

  const samples: MemorySample[] = [];
  let lastWarnAt: number | null = null;

  const tick = () => {
    let s: MemorySample;
    try {
      s = sample();
    } catch {
      return; // sampling must never break the server
    }
    samples.push(s);
    if (samples.length > ringSize) samples.splice(0, samples.length - ringSize);
    if (s.rss >= warnThresholdBytes && (lastWarnAt === null || now() - lastWarnAt >= WARN_INTERVAL_MS)) {
      lastWarnAt = now();
      const rssMb = Math.round(s.rss / (1024 * 1024));
      const thresholdMb = Math.round(warnThresholdBytes / (1024 * 1024));
      warn(`⚠️  opencodex RSS ${rssMb}MB exceeds the ${thresholdMb}MB watch threshold. On Windows this is usually the upstream Bun runtime memory issue — see ${DOCS_URL}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  const instance: MemoryWatchdog = {
    stop() {
      clearInterval(timer);
      if (active === instance) active = null;
    },
    snapshot() {
      return { samples: [...samples], warnThresholdBytes, lastWarnAt };
    },
  };
  active = instance;
  return instance;
}
