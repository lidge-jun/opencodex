import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import {
  LONG_RETRY_AFTER_SECONDS,
  MUSE_QUOTA_EXHAUSTED_MESSAGE,
  MUSE_QUOTA_WINDOW_EXHAUSTED_HEADER,
  MUSE_SUBSCRIPTION_PROVIDER,
  rewriteMuseQuotaExhaustedResponse,
} from "../../src/responses/muse-quota-refusal";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseSpendHome: (() => void) | undefined;

const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
});

function refusal(options: {
  retryAfter?: string;
  message?: string;
  contentType?: string;
  status?: number;
} = {}): Response {
  const message = options.message ?? `${MUSE_QUOTA_EXHAUSTED_MESSAGE}. Your usage window resets at 2026-11-01T10:49:49Z.`;
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  if (options.retryAfter !== undefined) headers.set("retry-after", options.retryAfter);
  return new Response(JSON.stringify({
    error: { code: "rate_limit_exceeded", message, param: null, resets_at: 1793530189, type: "rate_limit_error" },
  }), { status: options.status ?? 429, headers });
}

describe("Muse quota refusal", () => {
  test("drops a window-length retry-after on the subscription route", async () => {
    const rewritten = await rewriteMuseQuotaExhaustedResponse(
      refusal({ retryAfter: "2248" }),
      MUSE_SUBSCRIPTION_PROVIDER,
    );
    expect(rewritten.status).toBe(429);
    expect(rewritten.headers.get("retry-after")).toBeNull();
    expect(rewritten.headers.get(MUSE_QUOTA_WINDOW_EXHAUSTED_HEADER)).toBe("1");
    expect(await rewritten.text()).toContain(MUSE_QUOTA_EXHAUSTED_MESSAGE);
  });

  test("leaves another provider's matching refusal alone", async () => {
    const response = refusal({ retryAfter: "2248" });
    const foreign = await rewriteMuseQuotaExhaustedResponse(response, "meta-model");
    expect(foreign).toBe(response);
    expect(foreign.headers.get("retry-after")).toBe("2248");
  });

  test("leaves a short retry-after alone", async () => {
    const response = refusal({ retryAfter: String(LONG_RETRY_AFTER_SECONDS) });
    expect(await rewriteMuseQuotaExhaustedResponse(response, MUSE_SUBSCRIPTION_PROVIDER)).toBe(response);
  });

  test("leaves a long retry-after alone when the refusal is not a quota window", async () => {
    const rewritten = await rewriteMuseQuotaExhaustedResponse(
      refusal({ retryAfter: "2248", message: "Slow down" }),
      MUSE_SUBSCRIPTION_PROVIDER,
    );
    expect(rewritten.status).toBe(429);
    expect(rewritten.headers.get("retry-after")).toBe("2248");
    expect(await rewritten.text()).toContain("Slow down");
  });

  test("ignores responses that are not JSON 429 refusals", async () => {
    const notFound = refusal({ retryAfter: "2248", status: 404 });
    expect(await rewriteMuseQuotaExhaustedResponse(notFound, MUSE_SUBSCRIPTION_PROVIDER)).toBe(notFound);
    const sse = refusal({ retryAfter: "2248", contentType: "text/event-stream" });
    expect(await rewriteMuseQuotaExhaustedResponse(sse, MUSE_SUBSCRIPTION_PROVIDER)).toBe(sse);
  });
});

describe("Muse quota refusal through handleResponses", () => {
  const provider = {
    adapter: "openai-responses",
    baseUrl: "https://api.meta.ai/v1",
    authMode: "key",
    apiKey: "test-key",
  };
  // The registry pins `meta-muse` to OAuth, so a direct-dispatch case cannot reach it
  // with a fixture key. The rewrite's positive path is covered by the unit cases above;
  // what an integration case must prove is that another route keeps its own delay.
  const config = {
    port: 0,
    defaultProvider: MUSE_SUBSCRIPTION_PROVIDER,
    providers: {
      fixture: provider,
    },
  } as OcxConfig;

  async function call(model: string): Promise<Response> {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => refusal({ retryAfter: "2248" })) as typeof fetch;
    try {
      takeSpendHome();
      return await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true, input: "say ok" }),
      }), config, { model: "", provider: "" });
    } finally {
      globalThis.fetch = savedFetch;
    }
  }

  test("another provider keeps its own retry-after", async () => {
    const response = await call("fixture/muse-wonder-1.0");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2248");
    expect(response.headers.get(MUSE_QUOTA_WINDOW_EXHAUSTED_HEADER)).toBeNull();
  });
});

