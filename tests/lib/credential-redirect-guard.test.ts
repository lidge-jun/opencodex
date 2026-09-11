/**
 * Cross-origin redirect guard for credential-bearing sidecars (#1471 review).
 *
 * Exercise production transports against two loopback origins. Safety is a property of the
 * application send boundary, independent of which headers a particular runtime happens to
 * strip when following redirects. Existing explicit sidecar guards remain checked below.
 */
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import { fetchWithHeaderTimeout, providerFetch } from "../../src/server/responses/fetch-helpers";
import { fetchWithAttemptDeadline } from "../../src/lib/upstream-retry";
import { fetchWithHeaderDeadline } from "../../src/server/claude-messages";
import { fetchGoogleWithRetry } from "../../src/adapters/google-http";
import { fetchKiroWithRetry } from "../../src/adapters/kiro-retry";
import type { OcxProviderConfig } from "../../src/types";

describe("credential-bearing production transports do not follow redirects", () => {
  const nativeFetch = globalThis.fetch;
  const senders = ["header", "header-legacy-false", "deadline", "provider", "provider-rebuilt", "claude", "google", "kiro"] as const;
  for (const sender of senders) for (const sameOrigin of [false, true]) test.each([301, 302, 303, 307, 308])(`${sender} ${sameOrigin ? "same" : "cross"}-origin: preserves %i without a target send`, async status => {
    let targetHits = 0;
    let originHits = 0;
    const observedRedirect: Array<RequestRedirect | undefined> = [];
    const target = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        targetHits += 1;
        return new Response("ok");
      },
    });
    const origin = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: req => {
        if (new URL(req.url).pathname === "/landed") {
          targetHits += 1;
          return new Response("ok");
        }
        originHits += 1;
        return new Response("untrusted redirect body", {
          status,
          headers: { location: sameOrigin ? "/landed" : `http://127.0.0.1:${target.port}/landed` },
        });
      },
    });
    let response: Response | undefined;
    try {
      const url = `http://127.0.0.1:${origin.port}/start`;
      const init: RequestInit = {
        method: "POST", body: "synthetic request", redirect: "follow",
        headers: {
          authorization: "Bearer synthetic-token",
          "x-api-key": "synthetic-provider-key",
          "chatgpt-account-id": "acct-123",
        },
      };
      const executor = (async (input, sentInit) => {
        observedRedirect.push(sentInit?.redirect);
        return nativeFetch(input, sentInit);
      }) as typeof globalThis.fetch;
      const signal = new AbortController().signal;
      if (sender === "header") response = await fetchWithHeaderTimeout(url, init, signal, 2_000, false, executor);
      else if (sender === "header-legacy-false") response = await fetchWithHeaderTimeout(url, init, signal, 2_000, false, executor, false);
      else if (sender === "deadline") response = await fetchWithAttemptDeadline(url, init, 2_000, signal, false, executor);
      else if (sender === "claude") {
        const result = await fetchWithHeaderDeadline(url, init, 2_000, signal, undefined, executor);
        expect(result.kind).toBe("response");
        if (result.kind === "response") response = result.upstream;
      } else if (sender === "google" || sender === "kiro") {
        const request = { url, method: "POST", headers: init.headers as Record<string, string>, body: init.body as string };
        const context = { abortSignal: signal, timeoutMs: 2_000, returnRawErrors: true, executor };
        if (sender === "google") response = await fetchGoogleWithRetry("test", request, context);
        else {
          globalThis.fetch = executor;
          response = await fetchKiroWithRetry(request, context);
        }
      }
      else {
        const provider = { adapter: "openai-chat", baseUrl: url, fetch: executor } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
        const fetcher = providerFetch(provider, undefined, sender === "provider-rebuilt" ? {
          dispatchOverride: (input, sentInit, execute) => execute(input, { ...sentInit, redirect: "follow" }),
        } : {});
        response = await fetcher(url, init);
      }
      expect(targetHits).toBe(0);
      expect(originHits).toBe(1);
      expect(observedRedirect).toEqual(["manual"]);
      expect(response?.status).toBe(status);
      expect(response?.headers.get("location")).toBe(sameOrigin ? "/landed" : `http://127.0.0.1:${target.port}/landed`);
    } finally {
      globalThis.fetch = nativeFetch;
      await response?.body?.cancel();
      await origin.stop(true);
      await target.stop(true);
    }
  });
});

describe("credential-bearing sidecars refuse to follow redirects", () => {
  const sites: Array<{ file: string; label: string }> = [
    { file: "src/server/images.ts", label: "images relay" },
    { file: "src/images/xai-client.ts", label: "xAI images client" },
    { file: "src/server/live.ts", label: "live relay" },
    { file: "src/server/search.ts", label: "search relay" },
    { file: "src/web-search/executor.ts", label: "web-search sidecar" },
    { file: "src/vision/describe.ts", label: "vision sidecar" },
  ];

  for (const { file, label } of sites) {
    test(`${label} sets redirect: "manual"`, async () => {
      const source = await Bun.file(repoPath(file)).text();
      expect(source).toContain('redirect: "manual"');
    });
  }

  // These source checks supplement, rather than replace, the physical-send tests above.
});
