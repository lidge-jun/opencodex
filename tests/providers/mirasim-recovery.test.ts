import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMirasimDeviceIdentity } from "../../src/adapters/mirasim/crypto";
import {
  fetchMirasimControl,
  resetMirasimTransportStateForTests,
} from "../../src/adapters/mirasim/transport";
import { getValidAccessTokenSnapshot } from "../../src/oauth";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "opencodex-mirasim-recovery-"));
  mkdirSync(home, { recursive: true });
  process.env.OPENCODEX_HOME = home;
  globalThis.fetch = originalFetch;
  resetMirasimTransportStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetMirasimTransportStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function credential(options: {
  access?: string;
  refresh?: string;
  expires?: number;
} = {}) {
  const identity = createMirasimDeviceIdentity();
  return {
    access: options.access ?? "mirasim-old-access",
    refresh: options.refresh ?? "mirasim-old-refresh",
    expires: options.expires ?? Date.now() + 3_600_000,
    source: "oauth" as const,
    accountId: "mirasim-recovery-account",
    mirasim: {
      devicePrivateKey: identity.privateKeyPem,
      relayUrl: "https://relay.mirasim.ai",
      adminUrl: "https://auth.mirasim.ai",
      clientVersion: "0.0.336",
    },
  };
}

function bearerHeader(value: string): string {
  return `Bearer ${value}`;
}

function mirasimConfig(fakeFetch: typeof fetch): OcxConfig {
  const entry = getProviderRegistryEntry("mirasim");
  if (!entry) throw new Error("missing Mirasim registry entry");
  const provider = {
    ...providerConfigSeed(entry),
    fetch: fakeFetch,
  } as OcxProviderConfig & { fetch: typeof fetch };
  return {
    port: 0,
    defaultProvider: "mirasim",
    providers: { mirasim: provider },
  } as OcxConfig;
}

describe("Mirasim OAuth recovery", () => {
  test("terminal invalid_grant marks the exact account for reauthentication and is not retried forever", async () => {
    await saveCredential("mirasim", credential({ expires: Date.now() - 1_000 }));

    let refreshCalls = 0;
    globalThis.fetch = (async () => {
      refreshCalls += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_grant" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(getValidAccessTokenSnapshot("mirasim")).rejects.toThrow("Not logged in");
    expect(getAccountSet("mirasim")?.accounts[0]?.needsReauth).toBe(true);

    await expect(getValidAccessTokenSnapshot("mirasim")).rejects.toThrow("Not logged in");
    expect(refreshCalls).toBe(1);
  });

  test("device-session 401 force-refreshes the OAuth snapshot once and rebuilds the signed request", async () => {
    await saveCredential("mirasim", credential());

    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url).pathname !== "/auth/refresh") throw new Error(`unexpected auth URL: ${url}`);
      refreshCalls += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: "mirasim-old-refresh" });
      return new Response(JSON.stringify({
        access_token: "mirasim-new-access",
        refresh_token: "mirasim-new-refresh",
        expires_in: 1800,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let sessionCalls = 0;
    let inferenceCalls = 0;
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const path = new URL(url).pathname;
      const headers = new Headers(init?.headers);

      if (path === "/v1/device/session") {
        sessionCalls += 1;
        const bearer = headers.get("authorization");
        if (bearer === bearerHeader("mirasim-old-access")) {
          return new Response(JSON.stringify({ error: "expired access token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe(bearerHeader("mirasim-new-access"));
        return new Response(JSON.stringify({ ticket: "mirasim-fresh-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (path === "/v1/responses") {
        inferenceCalls += 1;
        expect(headers.get("authorization")).toBe(bearerHeader("mirasim-fresh-ticket"));
        const terminal = {
          type: "response.completed",
          response: {
            id: "resp_mirasim_recovery",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.6-luna",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        };
        return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "mirasim/gpt-5.6-luna",
          input: "hello",
          stream: false,
        }),
      }), mirasimConfig(relayFetch), { model: "", provider: "" }, {
        abortSignal: AbortSignal.timeout(5_000),
      });

      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
      expect(sessionCalls).toBe(2);
      expect(inferenceCalls).toBe(1);
      expect(getAccountSet("mirasim")?.accounts[0]?.credential).toMatchObject({
        access: "mirasim-new-access",
        refresh: "mirasim-new-refresh",
      });
    } finally {
      releaseSpendHome();
    }
  });

  test("inference 401 refreshes access before the shared four-send budget is exhausted", async () => {
    await saveCredential("mirasim", credential());

    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url).pathname !== "/auth/refresh") throw new Error(`unexpected auth URL: ${url}`);
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "mirasim-inference-new-access",
        refresh_token: "mirasim-inference-new-refresh",
        expires_in: 1800,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let sessionCalls = 0;
    let inferenceCalls = 0;
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const bearer = new Headers(init?.headers).get("authorization");
      if (path === "/v1/device/session") {
        sessionCalls += 1;
        const ticket = bearer === bearerHeader("mirasim-old-access") ? "old-ticket" : "new-ticket";
        if (bearer !== bearerHeader("mirasim-old-access")) {
          expect(bearer).toBe(bearerHeader("mirasim-inference-new-access"));
        }
        return new Response(JSON.stringify({ ticket, expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/responses") {
        inferenceCalls += 1;
        if (bearer === bearerHeader("old-ticket")) {
          return new Response(JSON.stringify({ error: "expired access token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe(bearerHeader("new-ticket"));
        const terminal = {
          type: "response.completed",
          response: {
            id: "resp_mirasim_inference_recovery",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-5.6-luna",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        };
        return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mirasim/gpt-5.6-luna", input: "hello", stream: false }),
      }), mirasimConfig(relayFetch), { model: "", provider: "" }, {
        abortSignal: AbortSignal.timeout(5_000),
      });

      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
      expect(sessionCalls).toBe(2);
      expect(inferenceCalls).toBe(2);
    } finally {
      releaseSpendHome();
    }
  });

  test("native compact 401 force-refreshes the OAuth snapshot before replaying", async () => {
    await saveCredential("mirasim", credential());

    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url).pathname !== "/auth/refresh") throw new Error(`unexpected auth URL: ${url}`);
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "mirasim-compact-new-access",
        refresh_token: "mirasim-compact-new-refresh",
        expires_in: 1800,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let sessionCalls = 0;
    let compactCalls = 0;
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const bearer = new Headers(init?.headers).get("authorization");
      if (path === "/v1/device/session") {
        sessionCalls += 1;
        if (bearer === bearerHeader("mirasim-old-access")) {
          return new Response(JSON.stringify({ ticket: "compact-old-ticket", expiresIn: 600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe(bearerHeader("mirasim-compact-new-access"));
        return new Response(JSON.stringify({ ticket: "compact-new-ticket", expiresIn: 600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v1/responses/compact") {
        compactCalls += 1;
        if (bearer === bearerHeader("compact-old-ticket")) {
          return new Response(JSON.stringify({ error: "expired access token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        expect(bearer).toBe(bearerHeader("compact-new-ticket"));
        return new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const releaseSpendHome = acquireOwnedSpendHome();
    try {
      const response = await handleResponsesCompact(new Request("http://127.0.0.1/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mirasim/gpt-5.6-luna", input: [{ role: "user", content: "compact this" }] }),
      }), mirasimConfig(relayFetch), { model: "", provider: "" });

      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
      expect(sessionCalls).toBe(2);
      expect(compactCalls).toBe(2);
      expect(getAccountSet("mirasim")?.accounts[0]?.credential).toMatchObject({
        access: "mirasim-compact-new-access",
        refresh: "mirasim-compact-new-refresh",
      });
    } finally {
      releaseSpendHome();
    }
  });

  test("control-plane 401 force-refreshes the same OAuth account before replaying", async () => {
    await saveCredential("mirasim", credential());

    let refreshCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (new URL(url).pathname !== "/auth/refresh") throw new Error(`unexpected auth URL: ${url}`);
      refreshCalls += 1;
      return new Response(JSON.stringify({
        access_token: "mirasim-control-new-access",
        refresh_token: "mirasim-control-new-refresh",
        expires_in: 1800,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let controlCalls = 0;
    const relayFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      controlCalls += 1;
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === bearerHeader("mirasim-old-access")) {
        return new Response(JSON.stringify({ error: "expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      expect(bearer).toBe(bearerHeader("mirasim-control-new-access"));
      return new Response(JSON.stringify({ version: "1", agents: { claude: [], codex: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = mirasimConfig(relayFetch);
    const provider = config.providers.mirasim!;
    const response = await fetchMirasimControl(
      "mirasim",
      provider,
      "mirasim-old-access",
      "/v1/model-roster",
      { credentialMode: "access-token", timeoutMs: 1_000 },
    );

    expect(response.status).toBe(200);
    expect(refreshCalls).toBe(1);
    expect(controlCalls).toBe(2);
    expect(getAccountSet("mirasim")?.accounts[0]?.credential).toMatchObject({
      access: "mirasim-control-new-access",
      refresh: "mirasim-control-new-refresh",
    });
  });
});
