import { startSelfSampler } from "./macos-rss-retention-sampler";

const [opencodexHome, codexHome, upstream, seriesPath, enabled] = Bun.argv.slice(2);
if (
  !opencodexHome
  || !codexHome
  || !upstream
  || !seriesPath
  || !["on", "off"].includes(enabled ?? "")
) {
  throw new Error("invalid real-child arguments");
}

for (const key of Object.keys(process.env)) {
  if (
    /^(?:OPENAI_|CODEX_|OPENCODEX_)/.test(key)
    || /^(?:http|https|all)_proxy$/i.test(key)
  ) {
    delete process.env[key];
  }
}

Object.assign(process.env, {
  OPENCODEX_HOME: opencodexHome,
  CODEX_HOME: codexHome,
  OPENCODEX_API_AUTH_TOKEN: "fixture-admission",
  NO_PROXY: "127.0.0.1,localhost,::1",
  no_proxy: "127.0.0.1,localhost,::1",
});

const [{ saveConfig }, { startServer }] = await Promise.all([
  import("../src/config"),
  import("../src/server"),
]);

saveConfig({
  port: 0,
  hostname: "127.0.0.1",
  defaultProvider: "fixture",
  streamMode: "legacy-tee",
  providers: {
    fixture: {
      adapter: "openai-responses",
      baseUrl: upstream,
      authMode: "key",
      apiKey: "fixture-key",
      allowPrivateNetwork: true,
      liveModels: false,
      models: ["fixture-model"],
    },
  },
});

const server = startServer(0);
const sampler = await startSelfSampler({
  enabled: enabled === "on",
  path: seriesPath,
  mode: "real-proxy-legacy-tee",
});

process.stdout.write(JSON.stringify({
  type: "ready",
  pid: process.pid,
  port: server.port,
  watchdogIncluded: true,
}) + "\n");

/**
 * GC control channel (devlog/_plan/260822_260822-bun14-followup-memory/020):
 * SIGUSR2 runs a full collection INSIDE the measured process and reports a
 * timestamped receipt with the measured pause on the same stdout JSONL channel
 * as "ready". Only the GC-relief evaluation orchestrator uses it, and it sets
 * OCX_GC_EVAL=1 to install the handler.
 *
 * The gate is an env var rather than a comment because the locked 7h retention
 * protocol must not be able to collect mid-run: a stray SIGUSR2 from any source
 * would silently alter the very measurement that protocol exists to take.
 * "Our orchestrator never sends it" is a claim about one sender, not a property
 * of the process.
 */
if (process.env.OCX_GC_EVAL === "1") {
  process.on("SIGUSR2", () => {
  const t0 = Bun.nanoseconds();
  try {
    Bun.gc(true);
    const durationMs = (Bun.nanoseconds() - t0) / 1e6;
    process.stdout.write(JSON.stringify({ type: "gc", at: Date.now(), durationMs }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({
      type: "gc-error",
      at: Date.now(),
      message: error instanceof Error ? error.message : String(error),
    }) + "\n");
  }
  });
}

await new Promise<void>((resolve) => {
  let closing = false;

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;

    // Every cleanup is attempted so one failed flush cannot strand the server.
    const errors: unknown[] = [];
    try {
      await sampler.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await server.stop(true);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      process.stderr.write(`${new AggregateError(errors, "real child cleanup failed")}\n`);
      process.exitCode = 1;
    }
    resolve();
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
});
