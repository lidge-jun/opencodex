import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  acquireNativeMainProfileDrain,
  getNativeMainProfileRequestCount,
} from "../src/server/lifecycle";
import { waitForNativeMainStartupGate } from "../src/codex/native-profile-startup";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import type { OcxConfig } from "../src/types";
import { ownedServiceHomeInspection } from "./helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Issue #2132: bearer admission must not require a stored ChatGPT credential.
 *
 * #1686 made a caller that proves admission with one of OUR secrets substitute the stored
 * main credential, so the admission secret never leaves the process. That is right for a
 * route that actually reaches the ChatGPT backend. It was applied by asking HOW the caller
 * authenticated and never WHERE the request routes, so a request bound for a
 * key-authenticated provider — which carries its own credential and never touches ChatGPT —
 * was gated on a credential it has no use for. An install that deliberately never logged
 * into ChatGPT got 401 "No usable Codex main credential" on every request.
 *
 * The substitution itself is unchanged and still fails closed for native routes; only the
 * question it is asked changes.
 */

const originalFetch = globalThis.fetch;
const previousOcxHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;

let ocxHome = "";
let codexHome = "";
let routedAuth: Array<string | null> = [];
let nativeAuth: Array<string | null> = [];

const ADMISSION_SECRET = "ocx_data_2132secret";
const ROUTED_KEY = "sk-routed-provider-key";
const inspectNativeCodexOwnership = ownedServiceHomeInspection("bearer admission routed provider test");

/** A JWT whose `exp` is far in the future, so a stored main token reads as live. */
function liveJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  return `header.${payload}.signature`;
}

/**
 * A remote bind (so admission is required rather than loopback-waived) with BOTH a native
 * openai row and a key-authenticated routed provider. The routed provider is the one under
 * test; the native row has to exist for the negative case to be reachable.
 */
function mixedConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        defaultModel: "gpt-5.5",
      },
      gateway: {
        adapter: "openai-chat",
        baseUrl: "https://gateway.example.com/v1",
        authMode: "key",
        apiKey: ROUTED_KEY,
        models: ["gateway-model"],
      },
    },
    apiKeys: [
      { id: "env-key", name: "env_key", key: ADMISSION_SECRET, createdAt: "2026-08-20T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

beforeEach(() => {
  ocxHome = mkdtempSync(join(tmpdir(), "ocx-2132-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-2132-codex-"));
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  routedAuth = [];
  nativeAuth = [];
  globalThis.fetch = (async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (url.hostname === "gateway.example.com") {
      routedAuth.push(headers.get("authorization"));
      return Response.json({
        id: "chatcmpl_2132",
        object: "chat.completion",
        created: 0,
        model: "gateway-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    }
    if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") {
      nativeAuth.push(headers.get("authorization"));
      return Response.json({ id: "resp_2132", object: "response", status: "completed", output: [] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (ocxHome) removeTreeWithRetry(ocxHome);
  if (codexHome) removeTreeWithRetry(codexHome);
  ocxHome = "";
  codexHome = "";
});

async function postResponses(url: string | URL, model: string): Promise<Response> {
  return originalFetch(new URL("/v1/responses", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMISSION_SECRET}` },
    body: JSON.stringify({ model, input: "hi", stream: false }),
  });
}

describe("#2132 bearer admission does not require a ChatGPT credential for routed providers", () => {
  test("a key-authenticated route is served with no stored main credential", async () => {
    saveConfig(mixedConfig());
    // The reported install: no ChatGPT login was ever performed.
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      const response = await postResponses(server.url, "gateway/gateway-model");

      // Before this change the same request answered 401 "No usable Codex main credential",
      // because admission-by-bearer alone decided a ChatGPT token had to be substituted.
      expect(response.status).toBe(200);
      // The provider's own key is what authenticates it, and our admission secret stays home.
      expect(routedAuth).toEqual([`Bearer ${ROUTED_KEY}`]);
      expect(routedAuth.join("|")).not.toContain(ADMISSION_SECRET);
      expect(nativeAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a native route with no stored main credential still fails closed", async () => {
    saveConfig(mixedConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "gpt-5.5");

      // This is the #1686 guarantee and it must survive: a native route genuinely needs the
      // stored credential, so it fails BEFORE any upstream I/O rather than forwarding ours.
      expect(response.status).toBe(401);
      expect(nativeAuth).toHaveLength(0);
      expect(routedAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a native route still substitutes the stored main credential when one exists", async () => {
    saveConfig(mixedConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "gpt-5.5");

      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
    } finally {
      await server.stop(true);
    }
  });
});

/**
 * The predicate above must be keyed on TRANSPORT, not on the provider's name.
 *
 * `codexAccountMode` comes from `providerCodexAccountMode`, which special-cases the id
 * `openai`. The passthrough adapter decides whether it may forward caller credentials from
 * `isCanonicalOpenAiForwardProvider` — adapter, auth mode, and base URL. A row the operator
 * named anything else, pointed at the canonical ChatGPT backend, satisfies the adapter's test
 * and fails the name-based one. Substitution was therefore skipped and the adapter forwarded
 * our own admission secret to ChatGPT.
 *
 * These assert the invariant rather than the implementation: an admission bearer must never
 * reach the wire, whatever the row is called.
 */
describe("an admission bearer never reaches a canonical ChatGPT transport, whatever the row is named", () => {
  function customNamedCanonicalConfig(): OcxConfig {
    const base = mixedConfig();
    return {
      ...base,
      defaultProvider: "mirror",
      providers: {
        ...base.providers,
        // Same adapter, same authMode, same canonical base URL as the `openai` row above.
        // Only the name differs — and the name is not what carries the header upstream.
        mirror: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          defaultModel: "gpt-5.5",
        },
      },
    } as OcxConfig;
  }

  test("with no stored credential it fails closed instead of forwarding our secret", async () => {
    saveConfig(customNamedCanonicalConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      const response = await postResponses(server.url, "mirror/gpt-5.5");

      // Fail-before-I/O is the contract (src/codex/auth-context.ts): the only two acceptable
      // outcomes for an admission bearer are replaced-with-stored-main, or refused. Reaching
      // upstream at all with our secret in hand is the failure this pins.
      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
      expect(response.status).not.toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("with a stored credential the stored one is what goes upstream", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    try {
      await waitForNativeMainStartupGate();
      await postResponses(server.url, "mirror/gpt-5.5");

      expect(nativeAuth.join("|")).not.toContain(ADMISSION_SECRET);
      for (const sent of nativeAuth) expect(sent).toBe(`Bearer ${stored}`);
    } finally {
      await server.stop(true);
    }
  });

  test("stored-main substitution respects a native-main drain", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );

    const server = startServer(0, { inspectNativeCodexOwnership });
    let drain: ReturnType<typeof acquireNativeMainProfileDrain> = null;
    try {
      await waitForNativeMainStartupGate();
      drain = acquireNativeMainProfileDrain("custom-forward-substitution");
      expect(drain).not.toBeNull();
      const response = await postResponses(server.url, "mirror/gpt-5.5");

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(nativeAuth).toHaveLength(0);
      expect(routedAuth).toHaveLength(0);
    } finally {
      drain?.release();
      await server.stop(true);
    }
  });

  test("stored-main substitution holds ownership until the upstream request settles", async () => {
    saveConfig(customNamedCanonicalConfig());
    const stored = liveJwt();
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored_main_acc" } }),
    );
    let signalUpstreamStarted!: () => void;
    const upstreamStarted = new Promise<void>((resolve) => { signalUpstreamStarted = resolve; });
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve; });
    globalThis.fetch = (async (input, init) => {
      const raw = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (new URL(raw).hostname === "chatgpt.com") {
        nativeAuth.push(headers.get("authorization"));
        signalUpstreamStarted();
        await upstreamGate;
        return Response.json({ id: "resp_2132_held", object: "response", status: "completed", output: [] });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0, { inspectNativeCodexOwnership });
    let pending: Promise<Response> | null = null;
    try {
      await waitForNativeMainStartupGate();
      pending = postResponses(server.url, "mirror/gpt-5.5");
      const switchUrl = new URL("http://localhost/api/native-main-profiles/switch");
      const switchRequest = () => new Request(switchUrl, {
        method: "POST",
        body: JSON.stringify({ target: "target", confirmedStopped: true }),
      });
      let switches = 0;
      const manager = {
        switch: async () => {
          switches += 1;
          return { ok: true };
        },
      } as unknown as NativeProfileManager;
      await upstreamStarted;
      expect(getNativeMainProfileRequestCount()).toBe(1);
      const blocked = await handleNativeProfileAPI(
        switchRequest(),
        switchUrl,
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(blocked?.status).toBe(409);
      expect(switches).toBe(0);

      releaseUpstream();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(nativeAuth).toEqual([`Bearer ${stored}`]);
      expect(getNativeMainProfileRequestCount()).toBe(0);
      const switched = await handleNativeProfileAPI(
        switchRequest(),
        switchUrl,
        {} as OcxConfig,
        { manager, drainTimeoutMs: 0 },
      );
      expect(switched?.status).toBe(200);
      expect(switches).toBe(1);
    } finally {
      releaseUpstream();
      await pending?.catch(() => {});
      await server.stop(true);
    }
  });
});
