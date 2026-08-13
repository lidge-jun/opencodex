import { afterEach, describe, expect, test } from "bun:test";
import {
  providerRequestPacingStatus,
  requestPacingIntervalMs,
  resetProviderRequestPacingForTest,
  waitForProviderRequestSlot,
} from "../src/providers/request-pacing";
import { providerFetch } from "../src/server/responses/fetch-helpers";
import { fetchWithHeaderTimeout } from "../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../src/types";

afterEach(() => resetProviderRequestPacingForTest());

function provider(requestPacing: OcxProviderConfig["requestPacing"]): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://example.test/v1", requestPacing };
}

describe("requestPacingIntervalMs", () => {
  test("uses the slower of provider RPM, provider delay, and model override", () => {
    const configured = provider({
      enabled: true,
      requestsPerMinute: 120,
      minIntervalMs: 700,
      models: {
        slow: { requestsPerMinute: 30 },
        attemptedFast: { requestsPerMinute: 600 },
      },
    });
    expect(requestPacingIntervalMs(configured, "ordinary")).toBe(700);
    expect(requestPacingIntervalMs(configured, "slow")).toBe(2_000);
    expect(requestPacingIntervalMs(configured, "attemptedFast")).toBe(700);
  });

  test("supports model-only pacing while unrelated models remain unpaced", () => {
    const configured = provider({ enabled: true, models: { slow: { minIntervalMs: 900 } } });
    expect(requestPacingIntervalMs(configured, "slow")).toBe(900);
    expect(requestPacingIntervalMs(configured, "other")).toBe(0);
  });
});

describe("provider request pacing queue", () => {
  test("spaces concurrent starts in one provider FIFO and exposes queue state", async () => {
    const starts: number[] = [];
    const fetchImpl = Object.assign(async () => {
      starts.push(Date.now());
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, requestsPerMinute: 600 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, "demo", "model-a");
    const pending = [send("https://example.test/v1/chat/completions"), send("https://example.test/v1/chat/completions"), send("https://example.test/v1/chat/completions")];
    await Bun.sleep(10);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    await Promise.all(pending);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(85);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(85);
    const status = providerRequestPacingStatus("demo", configured);
    expect(status.queued).toBe(0);
    expect(status.lastModelId).toBe("model-a");
  });

  test("aborted queued requests leave immediately and never consume a start", async () => {
    const configured = provider({ enabled: true, minIntervalMs: 1_000 });
    await waitForProviderRequestSlot("demo", configured, "first");
    const controller = new AbortController();
    const queued = waitForProviderRequestSlot("demo", configured, "cancelled", controller.signal);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    controller.abort();
    await expect(queued).rejects.toHaveProperty("name", "AbortError");
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(0);
  });

  test("a slow model override does not slow other models beyond the provider interval", async () => {
    const starts: Array<{ model: string; at: number }> = [];
    const configured = provider({
      enabled: true,
      minIntervalMs: 80,
      models: { slow: { minIntervalMs: 400 } },
    });
    await waitForProviderRequestSlot("demo", configured, "slow");
    starts.push({ model: "slow", at: Date.now() });
    await waitForProviderRequestSlot("demo", configured, "fast");
    starts.push({ model: "fast", at: Date.now() });
    expect(starts[1].at - starts[0].at).toBeGreaterThanOrEqual(65);
    expect(starts[1].at - starts[0].at).toBeLessThan(250);
  });

  test("the same model still observes its slower model override", async () => {
    const configured = provider({
      enabled: true,
      minIntervalMs: 50,
      models: { slow: { minIntervalMs: 180 } },
    });
    const first = Date.now();
    await waitForProviderRequestSlot("demo", configured, "slow");
    await waitForProviderRequestSlot("demo", configured, "slow");
    expect(Date.now() - first).toBeGreaterThanOrEqual(160);
  });

  test("a model waiting on its override does not block another eligible model", async () => {
    const configured = provider({
      enabled: true,
      minIntervalMs: 60,
      models: { slow: { minIntervalMs: 350 } },
    });
    await waitForProviderRequestSlot("demo", configured, "slow");
    const started = Date.now();
    const secondSlow = waitForProviderRequestSlot("demo", configured, "slow");
    const fast = waitForProviderRequestSlot("demo", configured, "fast");
    await fast;
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(Date.now() - started).toBeLessThan(220);
    await secondSlow;
  });

  test("disabled policies preserve the unpaced legacy path", async () => {
    const configured = provider({ enabled: false, requestsPerMinute: 1 });
    const started = Date.now();
    await Promise.all([
      waitForProviderRequestSlot("demo", configured, "a"),
      waitForProviderRequestSlot("demo", configured, "b"),
    ]);
    expect(Date.now() - started).toBeLessThan(50);
    expect(providerRequestPacingStatus("demo", configured).enabled).toBe(false);
  });

  test("queue waiting does not consume the response-header timeout budget", async () => {
    const fetchImpl = Object.assign(async () => {
      await Bun.sleep(20);
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, minIntervalMs: 120 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const executor = providerFetch(configured, "demo", "model-a");
    await fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {}, new AbortController().signal, 50, false, executor);
    const second = await fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {}, new AbortController().signal, 50, false, executor);
    expect(second.status).toBe(200);
  });
});
