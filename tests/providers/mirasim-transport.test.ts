import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirasimAdapter } from "../../src/adapters/mirasim";
import { createMirasimDeviceIdentity } from "../../src/adapters/mirasim/crypto";
import {
  fetchMirasim,
  MIRASIM_INTERNAL_WIRE_HEADER,
  mirasimSessionIdForTests,
  resetMirasimTransportStateForTests,
} from "../../src/adapters/mirasim/transport";
import { MIRASIM_CLIENT_VERSION } from "../../src/oauth/mirasim";
import { saveCredential } from "../../src/oauth/store";
import { sanitizePassthroughHeaders } from "../../src/server/relay";
import type { OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const previousClientVersion = process.env.MIRASIM_CLIENT_VERSION;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-transport-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  if (previousClientVersion === undefined) delete process.env.MIRASIM_CLIENT_VERSION;
  else process.env.MIRASIM_CLIENT_VERSION = previousClientVersion;
  resetMirasimTransportStateForTests();
});

afterEach(() => {
  resetMirasimTransportStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousClientVersion === undefined) delete process.env.MIRASIM_CLIENT_VERSION;
  else process.env.MIRASIM_CLIENT_VERSION = previousClientVersion;
  removeTreeWithRetry(home);
});

const request = {
  url: "https://relay.mirasim.ai/v1/responses",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

async function saveMirasimCredential(options: {
  access?: string;
  refresh?: string;
  devicePrivateKey?: string;
  clientVersion?: string;
} = {}) {
  const identity = options.devicePrivateKey
    ? createMirasimDeviceIdentity(options.devicePrivateKey)
    : createMirasimDeviceIdentity();
  const access = options.access ?? "transport-access";
  await saveCredential("mirasim", {
    access,
    refresh: options.refresh ?? "transport-refresh",
    expires: Date.now() + 3_600_000,
    source: "oauth",
    accountId: "transport-account",
    mirasim: {
      devicePrivateKey: identity.privateKeyPem,
      relayUrl: "https://relay.mirasim.ai",
      adminUrl: "https://auth.mirasim.ai",
      clientVersion: options.clientVersion ?? MIRASIM_CLIENT_VERSION,
    },
  });
  return { access, identity };
}

function successfulRelay(onInference?: (headers: Headers) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === "/v1/device/session") {
      return new Response(JSON.stringify({ ticket: "transport-ticket", expiresIn: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    onInference?.(new Headers(init?.headers));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Mirasim signed transport lifecycle", () => {
  test("cold ticket mint is admitted by the shared physical-send budget", async () => {
    const { access } = await saveMirasimCredential();
    let sessionCalls = 0;
    const executor = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/device/session") sessionCalls += 1;
      return new Response(JSON.stringify({ ticket: "should-not-mint", expiresIn: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const denyBudget = {
      used: 99,
      logicalRequestId: "mirasim-budget",
      policyVersion: "test",
      policy: {},
      reserveSpent: true,
      alternateTargetSends: 0,
      targetTransitions: 0,
      lastTargetKey: undefined,
      remainingBaseSends: () => 0,
      reserveDispatch: () => ({ allowed: false, reason: "base-allowance-exhausted" }),
    } as any;

    await expect(fetchMirasim(request, access, { executor, sendBudget: denyBudget })).rejects.toThrow();
    expect(sessionCalls).toBe(0);
  });

  test("concurrent cold requests singleflight one device-session mint", async () => {
    const { access } = await saveMirasimCredential();
    let sessionCalls = 0;
    let inferenceCalls = 0;
    const executor = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/device/session") {
        sessionCalls += 1;
        await Bun.sleep(25);
        return new Response(JSON.stringify({ ticket: "shared-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      inferenceCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await Promise.all(Array.from({ length: 8 }, () => fetchMirasim(request, access, { executor })));
    expect(sessionCalls).toBe(1);
    expect(inferenceCalls).toBe(8);
  });

  test("transient device-session failure backs off instead of mint-storming", async () => {
    const { access } = await saveMirasimCredential();
    let sessionCalls = 0;
    const executor = (async () => {
      sessionCalls += 1;
      return new Response("{}", { status: 503 });
    }) as typeof fetch;

    await expect(fetchMirasim(request, access, { executor })).rejects.toThrow();
    await expect(fetchMirasim(request, access, { executor })).rejects.toThrow();
    expect(sessionCalls).toBe(1);
  });

  test("inference header deadline uses timeoutMs without killing the response body later", async () => {
    const { access } = await saveMirasimCredential();
    const executor = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/device/session") {
        return new Response(JSON.stringify({ ticket: "timeout-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const parent = new AbortController();
    const parentTimer = setTimeout(() => parent.abort(new Error("parent timeout")), 300);
    const started = performance.now();
    try {
      await expect(fetchMirasim(request, access, {
        executor,
        abortSignal: parent.signal,
        timeoutMs: 25,
      })).rejects.toThrow();
    } finally {
      clearTimeout(parentTimer);
    }
    expect(performance.now() - started).toBeLessThan(150);
  });

  test("session identity survives access-token rotation for the same account and device", async () => {
    const first = await saveMirasimCredential({ access: "session-access-a", refresh: "session-refresh-a" });
    await fetchMirasim(request, first.access, { executor: successfulRelay() });
    const firstSession = mirasimSessionIdForTests(first.access);
    expect(firstSession).toStartWith("mirasim_");

    await saveMirasimCredential({
      access: "session-access-b",
      refresh: "session-refresh-b",
      devicePrivateKey: first.identity.privateKeyPem,
    });
    await fetchMirasim(request, "session-access-b", { executor: successfulRelay() });
    const secondSession = mirasimSessionIdForTests("session-access-b");

    expect(secondSession).toBe(firstSession);
  });

  test("runtime client version overrides a stale version persisted in an old credential", async () => {
    process.env.MIRASIM_CLIENT_VERSION = "9.9.9-test";
    const { access } = await saveMirasimCredential({ clientVersion: "0.0.100" });
    let observed = "";
    const executor = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/v1/device/session") {
        observed = new Headers(init?.headers).get("x-mirasim-client") ?? "";
        return new Response(JSON.stringify({ ticket: "version-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchMirasim(request, access, { executor });
    expect(observed).toBe("9.9.9-test");
  });

  test("GPT adapter responses carry an internal wire marker that passthrough sanitization strips", async () => {
    const { access } = await saveMirasimCredential();
    const provider = {
      adapter: "mirasim",
      baseUrl: "https://relay.mirasim.ai",
      authMode: "oauth",
      apiKey: access,
    } as OcxProviderConfig;
    const adapter = createMirasimAdapter(provider);
    const response = await adapter.fetchResponse!({
      ...request,
      headers: {
        ...request.headers,
        [MIRASIM_INTERNAL_WIRE_HEADER]: "responses",
      },
    }, { executor: successfulRelay() });

    expect(response.headers.get("x-opencodex-mirasim-response-wire")).toBe("responses");
    expect(sanitizePassthroughHeaders(response.headers).get("x-opencodex-mirasim-response-wire")).toBeNull();
  });
});
