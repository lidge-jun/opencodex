import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  markAccountNeedsReauth,
  updateAccountQuota,
} from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThreadDetailed,
} from "../src/codex/routing";
import { handleImagesRequest, selectImagesForwardProvider } from "../src/server/images";
import { MAX_DECOMPRESSED_BODY_BYTES } from "../src/server/request-decompress";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const ORIGINAL_FETCH = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-images-proxy-safety-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

function forwardProvider(baseUrl = "https://images.example/backend-api/codex") {
  return { adapter: "openai-responses", baseUrl, authMode: "forward" as const };
}

function mainConfig(): OcxConfig {
  return {
    defaultProvider: "images-forward",
    providers: { "images-forward": forwardProvider() },
  };
}

function poolConfig(accountId = "pool-a"): OcxConfig {
  return {
    ...mainConfig(),
    codexAccounts: [
      { id: "main", email: "main@example.test", isMain: true },
      { id: accountId, email: "pool@example.test", isMain: false, chatgptAccountId: `acct-${accountId}` },
    ],
    activeCodexAccountId: accountId,
    upstreamFailoverThreshold: 3,
  };
}

function seedPoolCredential(accountId = "pool-a"): void {
  saveCodexAccountCredential(accountId, {
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${accountId}`,
  });
  updateAccountQuota(accountId, 10, 10);
}

function imagesRequest(options: {
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
  operation?: "generations" | "edits";
} = {}): Request {
  const headers = new Headers({
    authorization: "Bearer inbound-main",
    "chatgpt-account-id": "acct-inbound-main",
    "content-type": "application/json",
  });
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return new Request(`http://localhost/v1/images/${options.operation ?? "generations"}`, {
    method: "POST",
    headers,
    body: options.body ?? "{}",
    signal: options.signal,
  });
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-images-safety-codex-");
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-missing");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-a");
  clearAccountNeedsReauth("pool-missing");
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("standalone Images proxy safety", () => {
  test("provider selection is deterministic and excludes disabled, key, and OAuth providers", async () => {
    const config: OcxConfig = {
      defaultProvider: "disabled-default",
      providers: {
        "disabled-default": { ...forwardProvider("https://disabled.example"), disabled: true },
        openai: { adapter: "openai-responses", baseUrl: "https://key.example/v1", authMode: "key", apiKey: "key" },
        chatgpt: forwardProvider("https://chatgpt.example/backend-api/codex"),
        firstFallback: forwardProvider("https://first.example/backend-api/codex"),
      },
    };
    expect(selectImagesForwardProvider(config)?.name).toBe("chatgpt");

    const defaultWins: OcxConfig = {
      defaultProvider: "custom",
      providers: {
        chatgpt: forwardProvider("https://chatgpt.example"),
        custom: forwardProvider("https://custom.example"),
        openai: forwardProvider("https://openai.example"),
      },
    };
    expect(selectImagesForwardProvider(defaultWins)?.name).toBe("custom");

    const stableFallback: OcxConfig = {
      providers: {
        zeta: forwardProvider("https://zeta.example"),
        alpha: forwardProvider("https://alpha.example"),
      },
    };
    expect(selectImagesForwardProvider(stableFallback)?.name).toBe("zeta");

    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({});
    }) as typeof fetch;
    const unavailable = await handleImagesRequest(imagesRequest(), {
      defaultProvider: "key-only",
      providers: {
        "key-only": { adapter: "openai-responses", baseUrl: "https://key.example/v1", authMode: "key", apiKey: "key" },
        oauth: { adapter: "openai-responses", baseUrl: "https://oauth.example/v1", authMode: "oauth" },
      },
    }, "generations");
    expect(unavailable.status).toBe(503);
    expect(upstreamCalls).toBe(0);
  });

  test("declared and actual stream overflow return 413 before fetch", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({ data: [{ b64_json: "AA==" }] });
    }) as typeof fetch;

    const declared = await handleImagesRequest(imagesRequest({
      body: "x",
      headers: { "content-length": String(MAX_DECOMPRESSED_BODY_BYTES + 1) },
    }), mainConfig(), "generations");
    expect(declared.status).toBe(413);

    const oneMiB = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let markCanceled!: () => void;
    const canceled = new Promise<void>(resolve => { markCanceled = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls < 257) {
          pulls += 1;
          controller.enqueue(oneMiB);
          return;
        }
        // Keep the source open after the overflow chunk. Closing here can be prefetched before the
        // collector calls cancel, and a closed stream correctly skips its underlying cancel hook.
        return new Promise<void>(() => {});
      },
      cancel() {
        markCanceled();
      },
    });
    // Bun wraps a stream passed through `new Request`, so its original cancel hook is not
    // observable. Supply the exact Request fields the handler consumes to verify the collector's
    // own reader cancellation deterministically.
    const streamedRequest = {
      body: stream,
      headers: new Headers({
        authorization: "Bearer inbound-main",
        "content-type": "application/json",
      }),
      signal: new AbortController().signal,
    } as unknown as Request;
    const streamed = await handleImagesRequest(streamedRequest, mainConfig(), "generations");
    expect(streamed.status).toBe(413);
    await Promise.race([
      canceled,
      new Promise((_, reject) => setTimeout(() => reject(new Error("oversize request reader was not canceled")), 500)),
    ]);
    expect(upstreamCalls).toBe(0);

    for (const malformed of ["not-a-number", "-1"]) {
      const accepted = await handleImagesRequest(imagesRequest({
        body: "{}",
        headers: { "content-length": malformed },
      }), mainConfig(), "generations");
      expect(accepted.status).toBe(200);
      await accepted.text();
    }
    expect(upstreamCalls).toBe(2);
  });

  test("non-identity content encodings return 415 before fetch", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({ data: [{ b64_json: "AA==" }] });
    }) as typeof fetch;

    for (const encoding of ["gzip", "br", "custom-encoding"]) {
      const rejected = await handleImagesRequest(imagesRequest({
        headers: { "content-encoding": encoding },
      }), mainConfig(), "generations");
      expect(rejected.status).toBe(415);
    }
    expect(upstreamCalls).toBe(0);

    const identity = await handleImagesRequest(imagesRequest({
      headers: { "content-encoding": "identity" },
    }), mainConfig(), "generations");
    expect(identity.status).toBe(200);
    await identity.text();
    expect(upstreamCalls).toBe(1);
  });

  test("upstream errors stay faithful and a reset is never retried", async () => {
    const upstreamBody = JSON.stringify({ error: { message: "quota reached" } });
    globalThis.fetch = (async () => new Response(upstreamBody, {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "content-type": "application/json",
        "retry-after": "17",
        "set-cookie": "private=session",
        "content-encoding": "gzip",
        "content-length": "999",
      },
    })) as typeof fetch;
    const relayed = await handleImagesRequest(imagesRequest(), mainConfig(), "generations");
    expect(relayed.status).toBe(429);
    expect(relayed.headers.get("retry-after")).toBe("17");
    expect(relayed.headers.get("set-cookie")).toBeNull();
    expect(relayed.headers.get("content-encoding")).toBeNull();
    expect(relayed.headers.get("content-length")).toBeNull();
    expect(await relayed.text()).toBe(upstreamBody);

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      const reset = new Error("connection reset by peer") as Error & { code: string };
      reset.code = "ECONNRESET";
      throw reset;
    }) as typeof fetch;
    const resetResponse = await handleImagesRequest(imagesRequest(), mainConfig(), "generations");
    expect(resetResponse.status).toBe(502);
    expect(attempts).toBe(1);
  });

  test("client cancellation aborts upstream before and after response headers", async () => {
    let markEntered!: () => void;
    let markAborted!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const abortedBeforeHeaders = new Promise<void>(resolve => { markAborted = resolve; });
    globalThis.fetch = ((_input, init) => {
      markEntered();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          markAborted();
          reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof fetch;

    const beforeController = new AbortController();
    const pending = handleImagesRequest(imagesRequest({ signal: beforeController.signal }), mainConfig(), "generations");
    await entered;
    beforeController.abort(new DOMException("client gone", "AbortError"));
    const beforeResponse = await pending;
    expect(beforeResponse.status).toBe(499);
    await abortedBeforeHeaders;

    let markSignalAbort!: () => void;
    let markBodyCancel!: () => void;
    const signalAborted = new Promise<void>(resolve => { markSignalAbort = resolve; });
    const bodyCanceled = new Promise<void>(resolve => { markBodyCancel = resolve; });
    const firstChunk = new TextEncoder().encode('{"data":[');
    globalThis.fetch = (async (_input, init) => {
      init?.signal?.addEventListener("abort", markSignalAbort, { once: true });
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(firstChunk);
            return;
          }
          return new Promise<void>(() => {});
        },
        cancel() {
          markBodyCancel();
        },
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const afterController = new AbortController();
    const afterResponse = await handleImagesRequest(imagesRequest({ signal: afterController.signal }), mainConfig(), "generations");
    const reader = afterResponse.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    afterController.abort(new DOMException("client gone", "AbortError"));
    await reader.cancel("client gone");
    await Promise.race([
      Promise.all([signalAborted, bodyCanceled]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream cancellation did not propagate")), 500)),
    ]);
  });

  test("pool failures update health and pool auth wins; main failures do not mutate pool health", async () => {
    const config = poolConfig();
    seedPoolCredential();
    let outboundHeaders = new Headers();
    globalThis.fetch = (async (_input, init) => {
      outboundHeaders = new Headers(init?.headers);
      return new Response("upstream failed", { status: 500 });
    }) as typeof fetch;

    const serverError = await handleImagesRequest(imagesRequest({
      headers: { "x-codex-parent-thread-id": "images-health-500" },
    }), config, "generations");
    expect(serverError.status).toBe(500);
    await serverError.text();
    expect(outboundHeaders.get("authorization")).toBe("Bearer access-pool-a");
    expect(outboundHeaders.get("chatgpt-account-id")).toBe("acct-pool-a");
    expect(getCodexUpstreamHealth("pool-a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 500 });

    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const connectError = await handleImagesRequest(imagesRequest({
      headers: { "x-codex-parent-thread-id": "images-health-connect" },
    }), config, "generations");
    expect(connectError.status).toBe(502);
    expect(getCodexUpstreamHealth("pool-a")).toMatchObject({ consecutiveFailures: 1, lastFailureStatus: 0 });

    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    globalThis.fetch = (async () => new Response("quota", {
      status: 429,
      headers: { "retry-after": "60" },
    })) as typeof fetch;
    const quota = await handleImagesRequest(imagesRequest({
      headers: { "x-codex-parent-thread-id": "images-health-429" },
    }), config, "generations");
    expect(quota.status).toBe(429);
    await quota.text();
    expect(getCodexUpstreamHealth("pool-a")).toMatchObject({ consecutiveFailures: 0, lastFailureStatus: 429 });

    clearCodexUpstreamHealth();
    globalThis.fetch = (async () => new Response("main failed", { status: 500 })) as typeof fetch;
    const mainFailure = await handleImagesRequest(imagesRequest(), mainConfig(), "generations");
    expect(mainFailure.status).toBe(500);
    await mainFailure.text();
    expect(getCodexUpstreamHealth("pool-a")).toBeNull();
  });

  test("auth cooldown, expired affinity, credential failure, and unusable context never fetch", async () => {
    let upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls += 1;
      return Response.json({});
    }) as typeof fetch;

    const missingConfig = poolConfig("pool-missing");
    updateAccountQuota("pool-missing", 10, 10);
    const missing = await handleImagesRequest(imagesRequest(), missingConfig, "generations");
    expect(missing.status).toBe(401);

    const config = poolConfig();
    seedPoolCredential();
    recordCodexUpstreamOutcome(config, "pool-a", 429, { retryAfter: "60" });
    const cooled = await handleImagesRequest(imagesRequest(), config, "generations");
    expect(cooled.status).toBe(429);

    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    const oldNow = Date.now() - CODEX_THREAD_AFFINITY_IDLE_TTL_MS - 1;
    expect(resolveCodexAccountForThreadDetailed("expired-images-thread", config, oldNow).status).toBe("selected");
    const expired = await handleImagesRequest(imagesRequest({
      headers: { "x-codex-parent-thread-id": "expired-images-thread" },
    }), config, "generations");
    expect(expired.status).toBe(409);

    clearThreadAccountMap();
    markAccountNeedsReauth("pool-a");
    const unusable = await handleImagesRequest(imagesRequest(), config, "generations");
    expect(unusable.status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });
});
