import { afterEach, describe, expect, test } from "bun:test";
import { planVideoBridge } from "../../src/images/plan";
import { pollVideoJob, submitVideoJob, type VideoOutboundDependencies, type VideoProviderAuth } from "../../src/images/xai-video-client";
import { resolvePublicAddresses } from "../../src/lib/destination-policy";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

// A custom video destination named by hostname, answered by DNS with an address the policy must judge.
const HOST = "video-relay.internal.example";
const KEY = "synthetic-video-bridge-key";

type ResolveOptions = Parameters<typeof resolvePublicAddresses>[1];
type Sent = { url: string; address: string; authorization: string | null };

/**
 * DNS for the test: `host` answers with `address`. The answer is classified by the real
 * resolvePublicAddresses (on the address literal) with the options the transport passed, so the
 * private-network decision under test is the production one.
 */
function dns(host: string, address: string, seen: ResolveOptions[] = []): NonNullable<VideoOutboundDependencies["resolveAddresses"]> {
  return async (url, options) => {
    seen.push(options);
    const target = new URL(url);
    if (target.hostname !== host) throw new Error("unexpected DNS lookup for " + target.hostname);
    target.hostname = address;
    const verdict = await resolvePublicAddresses(target.toString(), options);
    return { ...verdict, hostname: host };
  };
}

/** Pinned transport stand-in: records where the request was pinned and which key it carried. */
function transport(sent: Sent[], body: unknown): Pick<VideoOutboundDependencies, "pinnedGet" | "pinnedPost"> {
  const record = (url: string, pinned: { address: string }, options?: { headers?: HeadersInit }) => {
    sent.push({ url, address: pinned.address, authorization: new Headers(options?.headers).get("authorization") });
    return Promise.resolve(Response.json(body));
  };
  return {
    pinnedPost: async (url, pinned, _body, _signal, options) => record(url, pinned, options),
    pinnedGet: async (url, pinned, _signal, options) => record(url, pinned, options),
  };
}

// Anything reaching plain fetch bypassed the destination policy; record it and answer success.
const realFetch = globalThis.fetch;
let rawFetches: Array<{ url: string; authorization: string | null }> = [];
function trapRawFetch(): void {
  rawFetches = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    rawFetches.push({ url: String(input instanceof Request ? input.url : input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ request_id: "leaked", status: "done" });
  }) as typeof fetch;
}
afterEach(() => { globalThis.fetch = realFetch; });

const custom = (overrides: Partial<VideoProviderAuth> = {}): VideoProviderAuth => ({
  baseUrl: "https://" + HOST + "/v1", token: KEY, providerName: "my-video-relay", noProxy: HOST, ...overrides,
});
const xaiAuth: VideoProviderAuth = { baseUrl: "https://api.x.ai/v1", token: "xai-synthetic", providerName: "xai", noProxy: "api.x.ai" };

describe("video submit and poll enforce the resolved destination", () => {
  for (const phase of ["submit", "poll"] as const) {
    const call = (auth: VideoProviderAuth, deps: VideoOutboundDependencies) => phase === "submit"
      ? submitVideoJob({ prompt: "synthetic prompt" }, auth, undefined, deps)
      : pollVideoJob("job-1", auth, undefined, deps);
    const path = phase === "submit" ? "/v1/videos/generations" : "/v1/videos/job-1";

    test(phase + ": a hostname resolving to loopback is refused without allowPrivateNetwork and the key is never sent", async () => {
      trapRawFetch();
      const sent: Sent[] = [];
      const error = await call(custom(), { resolveAddresses: dns(HOST, "127.0.0.1"), ...transport(sent, { request_id: "r", status: "done" }) })
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("loopback");
      expect(sent).toEqual([]);
      expect(rawFetches).toEqual([]);
    });

    test(phase + ": the same host is reached at the resolved address with allowPrivateNetwork: true", async () => {
      trapRawFetch();
      const sent: Sent[] = [];
      await call(custom({ allowPrivateNetwork: true }), {
        resolveAddresses: dns(HOST, "127.0.0.1"), ...transport(sent, { request_id: "r", status: "processing" }),
      });
      expect(sent).toEqual([{ url: "https://" + HOST + path, address: "127.0.0.1", authorization: "Bearer " + KEY }]);
      expect(rawFetches).toEqual([]);
    });

    test(phase + ": the pinned xAI destination keeps its public-only policy", async () => {
      trapRawFetch();
      const sent: Sent[] = [];
      const seen: ResolveOptions[] = [];
      await call(xaiAuth, { resolveAddresses: dns("api.x.ai", "104.18.1.1", seen), ...transport(sent, { request_id: "r", status: "processing" }) });
      expect(sent).toEqual([{ url: "https://api.x.ai" + path, address: "104.18.1.1", authorization: "Bearer xai-synthetic" }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ allowPrivateNetwork: false });
      const refused = await call(xaiAuth, { resolveAddresses: dns("api.x.ai", "10.0.0.7"), ...transport(sent, {}) })
        .then(() => undefined, (caught: unknown) => caught);
      expect((refused as Error).message).toContain("private");
      expect(sent).toHaveLength(1);
      expect(rawFetches).toEqual([]);
    });
  }
});

describe("the plan carries the selected row's destination policy to the client", () => {
  const parsed = { modelId: "m", stream: true, options: {}, context: { messages: [], tools: [] } } as unknown as OcxParsedRequest;
  const routed = { baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "routed" } as OcxProviderConfig;
  const plan = (row: Partial<OcxProviderConfig>) => planVideoBridge({
    providers: { "my-video-relay": { adapter: "openai-chat", baseUrl: "https://" + HOST + "/v1", authMode: "key", apiKey: KEY, noProxy: HOST, ...row } },
    images: { videoBridgeEnabled: true, videoProvider: "my-video-relay" },
  } as unknown as OcxConfig, parsed, routed);

  test("a planned hostname row that resolves to loopback is refused unless the row opts in", async () => {
    trapRawFetch();
    const sent: Sent[] = [];
    const strict = await plan({});
    expect(strict?.auth).toBeDefined();
    const refused = await submitVideoJob({ prompt: "p" }, strict!.auth!, undefined, {
      resolveAddresses: dns(HOST, "127.0.0.1"), ...transport(sent, { request_id: "r" }),
    }).then(() => undefined, (caught: unknown) => caught);
    expect(refused).toBeInstanceOf(Error);
    expect(sent).toEqual([]);

    const optedIn = await plan({ allowPrivateNetwork: true });
    const result = await submitVideoJob({ prompt: "p" }, optedIn!.auth!, undefined, {
      resolveAddresses: dns(HOST, "127.0.0.1"), ...transport(sent, { request_id: "r-ok" }),
    });
    expect(result.requestId).toBe("r-ok");
    expect(sent).toEqual([{ url: "https://" + HOST + "/v1/videos/generations", address: "127.0.0.1", authorization: "Bearer " + KEY }]);
    expect(rawFetches).toEqual([]);
  });
});
