import { responseStateMetrics } from "../src/responses/state";
import { getActiveTurnCount } from "../src/server/lifecycle";

export type SampleMode =
  | "real-proxy-legacy-tee"
  | "single-reader-inspection"
  | "direct-http-baseline";

type Heap = {
  heapSize: number;
  heapCapacity: number;
  objectCount: number;
};

type SamplerOptions = {
  enabled: boolean;
  path: string;
  mode: SampleMode;
  activeCount?: () => number;
};

export async function startSelfSampler(options: SamplerOptions) {
  if (!options.enabled) {
    return {
      async stop() {
        return 0;
      },
    };
  }

  const writer = Bun.file(options.path).writer();
  let heapStats: (() => Heap) | null = null;
  try {
    heapStats = (await import("bun:jsc")).heapStats;
  } catch {
    heapStats = null;
  }

  const origin = performance.now();
  let sampleNumber = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = (): void => {
    if (stopped) return;

    const scheduled = origin + sampleNumber * 200;
    const actual = performance.now();
    const memory = process.memoryUsage();
    let jscHeap: Heap | null = null;
    try {
      // Keep the function, not a snapshot: heap state must be sampled live on every tick.
      jscHeap = heapStats ? heapStats() : null;
    } catch {
      jscHeap = null;
    }

    writer.write(JSON.stringify({
      type: "self-sample",
      wallMs: Date.now(),
      n: sampleNumber,
      scheduled,
      actual,
      latenessMs: actual - scheduled,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      jscHeap,
      responseState: responseStateMetrics(),
      activeTurnCount: (options.activeCount ?? getActiveTurnCount)(),
      mode: options.mode,
    }) + "\n");

    sampleNumber++;
    timer = setTimeout(
      tick,
      Math.max(0, origin + sampleNumber * 200 - performance.now()),
    );
  };

  tick();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);

      const errors: unknown[] = [];
      try {
        await writer.flush();
      } catch (error) {
        errors.push(error);
      }
      try {
        writer.end();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "sampler writer cleanup failed");
      }
      return sampleNumber;
    },
  };
}
