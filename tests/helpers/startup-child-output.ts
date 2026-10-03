export const STARTUP_OUTPUT_TAIL_CHARS = 8192;
const STARTUP_MARKER = "Client startup work complete.";

/** Fixture-only live diagnostics: drain both pipes without retaining an unbounded transcript. */
export function captureStartupChildOutput(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>) {
  const startedAt = Date.now();
  let lastOutputAt: number | null = null;
  let startupComplete = false;
  const collect = (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    let markerPrefix = "";
    let complete = false;
    let stopped = false;
    let readFailed = false;
    const append = (text: string) => {
      if (!text) return;
      lastOutputAt = Date.now();
      if (isStdout && !startupComplete) {
        const search = markerPrefix + text;
        startupComplete = search.includes(STARTUP_MARKER);
        markerPrefix = search.slice(-(STARTUP_MARKER.length - 1));
      }
      tail = (tail + text).slice(-STARTUP_OUTPUT_TAIL_CHARS);
    };
    const done = (async () => {
      try {
        while (!stopped) {
          const next = await reader.read();
          if (stopped) break;
          if (next.done) { append(decoder.decode()); complete = true; break; }
          append(decoder.decode(next.value, { stream: true }));
        }
      } catch { readFailed = true; }
      finally { reader.releaseLock(); }
    })();
    return {
      done,
      snapshot: () => ({ tail, complete, readFailed }),
      stop() {
        if (stopped || complete || readFailed) return;
        stopped = true;
        void reader.cancel().catch(() => {});
      },
    };
  };
  const out = collect(stdout, true);
  const err = collect(stderr, false);
  const snapshot = () => ({
    stdout: out.snapshot(), stderr: err.snapshot(), startupComplete,
    elapsedMs: Date.now() - startedAt,
    lastOutputAgoMs: lastOutputAt === null ? null : Date.now() - lastOutputAt,
  });
  const stop = () => { out.stop(); err.stop(); };
  return {
    snapshot, stop,
    async finish(timeoutMs = 1000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([out.done, err.done]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); stop(); }
      return snapshot();
    },
  };
}
