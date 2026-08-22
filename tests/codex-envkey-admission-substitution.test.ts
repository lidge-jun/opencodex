import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

/**
 * #1686 end to end: a Codex client injected with `env_key` presents the proxy admission
 * secret as `Authorization: Bearer`. Direct must ADMIT that request and substitute the
 * stored main credential; the admission secret must never appear upstream.
 *
 * The unit matrix in tests/codex-auth-context.test.ts proves the materializer in isolation.
 * It cannot prove the HTTP handler passes the presentation source down to it, which is the
 * half that was missing: the source was resolved at the door and dropped one frame later.
 */

const originalFetch = globalThis.fetch;
const previousOcxHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;

let ocxHome = "";
let codexHome = "";
let upstreamAuth: Array<string | null> = [];

const ADMISSION_SECRET = "ocx_data_envkeysecret";

/** A JWT whose `exp` is far in the future, so the stored main token reads as live. */
function liveJwt(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
  return `header.${payload}.signature`;
}

function directConfig(): OcxConfig {
  return {
    port: 0,
    // Remote bind, so admission is actually required rather than loopback-waived.
    hostname: "0.0.0.0",
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        defaultModel: "gpt-5.6-luna",
      },
    },
    apiKeys: [
      { id: "env-key", name: "env_key", key: ADMISSION_SECRET, createdAt: "2026-08-16T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

function writeStoredMain(accessToken: string): void {
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, account_id: "stored_main_acc" } }),
  );
}

beforeEach(() => {
  ocxHome = mkdtempSync(join(tmpdir(), "ocx-1686-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-1686-codex-"));
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  upstreamAuth = [];
  globalThis.fetch = (async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    if (url.hostname === "chatgpt.com" || url.hostname === "api.openai.com") {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      upstreamAuth.push(headers.get("authorization"));
      return Response.json({ id: "resp_1686", object: "response", status: "completed", output: [] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (ocxHome) rmSync(ocxHome, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  ocxHome = "";
  codexHome = "";
});

async function postResponses(url: string | URL, authorization: string): Promise<Response> {
  return originalFetch(new URL("/v1/responses", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi", stream: false }),
  });
}

describe("#1686 env_key bearer admission reaches Direct with substitution", () => {
  test("an admission bearer is served and the stored main credential goes upstream", async () => {
    setDebugSettings({ debug: true });
    saveConfig(directConfig());
    const stored = liveJwt();
    writeStoredMain(stored);

    const server = startServer(0);
    try {
      const response = await postResponses(server.url, `Bearer ${ADMISSION_SECRET}`);

      // Before this change the same request answered 401: admission accepted the bearer at the
      // door, then Direct refused it because it could not tell it from a user's own credential.
      expect(response.status).toBe(200);
      expect(upstreamAuth).toEqual([`Bearer ${stored}`]);
      // The proof that matters: our own secret never reached the wire.
      expect(upstreamAuth.join("|")).not.toContain(ADMISSION_SECRET);
      const affinityLine = getDebugLogEntries()
        .map(entry => entry.line)
        .find(line => line.startsWith("[ocx:codex:affinity] "));
      expect(affinityLine).toBeDefined();
      expect(JSON.parse(affinityLine!.slice("[ocx:codex:affinity] ".length))).toMatchObject({
        authKind: "main",
        accountMode: "direct",
        credentialSubstituted: true,
        status: 200,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("substitution fails closed before any upstream I/O when no main credential is stored", async () => {
    saveConfig(directConfig());
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));

    const server = startServer(0);
    try {
      const response = await postResponses(server.url, `Bearer ${ADMISSION_SECRET}`);

      expect(response.status).toBe(401);
      // Falling through would have forwarded the admission secret, which is the leak the
      // forward guard exists to prevent. Nothing may reach an upstream on this path.
      expect(upstreamAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a foreign bearer is still Codex Direct passthrough, not admission", async () => {
    saveConfig(directConfig());
    writeStoredMain(liveJwt());

    const server = startServer(0);
    try {
      // A real ChatGPT credential is NOT one of our secrets, so it must not be admitted as one.
      const response = await postResponses(server.url, "Bearer sk-user-chatgpt-token");
      expect(response.status).toBe(401);
      expect(upstreamAuth).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });
});
