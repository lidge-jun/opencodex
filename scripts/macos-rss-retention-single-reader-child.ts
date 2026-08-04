import { createSseInspector } from "../src/server/relay";
import type { RequestLogContext } from "../src/server/request-log";
import {
  startSelfSampler,
  type SampleMode,
} from "./macos-rss-retention-sampler";

const [upstream, seriesPath, eventsPath, rawMode, enabled] = Bun.argv.slice(2);
if (
  !upstream
  || !seriesPath
  || !eventsPath
  || !["single-reader-inspection", "direct-http-baseline"].includes(rawMode ?? "")
  || !["on", "off"].includes(enabled ?? "")
) {
  throw new Error("invalid relay arguments");
}

const mode = rawMode as SampleMode;
const events = Bun.file(eventsPath).writer();
let active = 0;

const record = (row: Record<string, unknown>): void => {
  events.write(JSON.stringify({ wallMs: Date.now(), ...row }) + "\n");
};

const sampler = await startSelfSampler({
  enabled: enabled === "on",
  path: seriesPath,
  mode,
  activeCount: () => active,
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("x-opencodex-api-key") !== "fixture-admission") {
      return new Response("unauthorized", { status: 401 });
    }

    const response = await fetch(upstream + "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.arrayBuffer(),
    });
    if (!response.body) return new Response("body missing", { status: 502 });

    const reader = response.body.getReader();
    const logCtx: RequestLogContext = {
      model: "fixture/fixture-model",
      provider: "fixture",
    };
    const inspector = mode === "single-reader-inspection"
      ? createSseInspector({
        logCtx,
        onFirstOutput: () => record({ type: "first-output" }),
        onTerminal: (status, override) => record({
          type: "terminal",
          status,
          override,
        }),
        onCompletedResponse: (responseValue) => record({
          type: "completed",
          id: typeof responseValue.id === "string" ? responseValue.id : null,
          outputs: Array.isArray(responseValue.output) ? responseValue.output.length : null,
          status: responseValue.status ?? null,
        }),
      })
      : null;

    active++;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      active--;
    };

    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            inspector?.finish();
            finish();
            controller.close();
            return;
          }
          inspector?.feed(part.value);
          controller.enqueue(part.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason).catch(() => undefined);
      },
    }), {
      status: response.status,
      headers: { "content-type": "text/event-stream" },
    });
  },
});

process.stdout.write(JSON.stringify({
  type: "ready",
  pid: process.pid,
  port: server.port,
}) + "\n");

await new Promise<void>((resolve) => {
  let closing = false;

  const stop = async (): Promise<void> => {
    if (closing) return;
    closing = true;

    // Flush telemetry independently from stopping the listener so both are attempted.
    const errors: unknown[] = [];
    try {
      await sampler.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await events.flush();
    } catch (error) {
      errors.push(error);
    }
    try {
      events.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await server.stop(true);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      process.stderr.write(`${new AggregateError(errors, "relay child cleanup failed")}\n`);
      process.exitCode = 1;
    }
    resolve();
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
});
