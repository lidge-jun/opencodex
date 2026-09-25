import { expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema/config-schema";

// The upstreamWebsocket + requestPacing.maxConcurrentRequests combination is legal but
// permanently moves the provider off the WebSocket fast lane; the operator hears it at
// config parse time, once per provider per process, not only on the first paced send.
const config = () => ({
  defaultProvider: "ws-capped",
  providers: {
    "ws-capped": {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      upstreamWebsocket: true,
      requestPacing: { enabled: true, maxConcurrentRequests: 4 },
    },
  },
});

test("upstreamWebsocket plus a concurrency cap warns once per provider at parse time", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  }) as typeof console.warn;
  try {
    const first = configSchema.parse(config());
    expect(first.providers["ws-capped"]).toBeDefined();
    configSchema.parse(config());
    const pacingWarnings = warnings.filter(
      warning => warning.includes("upstreamWebsocket") && warning.includes("maxConcurrentRequests"),
    );
    expect(pacingWarnings.length).toBe(1);
    expect(pacingWarnings[0]).toContain("served over HTTP/SSE");
  } finally {
    console.warn = originalWarn;
  }
});
