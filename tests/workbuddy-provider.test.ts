import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { saveConfig } from "../src/config";
import { getValidAccessTokenSnapshot, listOAuthProviders } from "../src/oauth";
import { getAccountSet, getCredential } from "../src/oauth/store";
import {
  buildWorkBuddyRequestHeaders,
  credentialFromWorkBuddySession,
  loginWorkBuddy,
  parseWorkBuddySession,
  refreshWorkBuddyToken,
  WORKBUDDY_EXTERNAL_SESSION_REFRESH,
  workBuddyAuthPath,
} from "../src/oauth/workbuddy";
import { deriveOAuthProviderConfig } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { WORKBUDDY_MODELS } from "../src/providers/workbuddy-models";
import { startServer } from "../src/server";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originalAuthFile = process.env.WORKBUDDY_AUTH_FILE;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
let testDir = "";
let authFile = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

function authPayload(
  accessToken: string,
  expiresAt = Date.now() + 3_600_000,
  userId = "fixture-user-id",
): string {
  return JSON.stringify({
    account: { uid: userId },
    auth: {
      accessToken,
      refreshToken: "desktop-owned-value",
      domain: "www.codebuddy.cn",
      expiresAt,
    },
  });
}

function parsedRequest(): OcxParsedRequest {
  return {
    modelId: "glm-5.2",
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: true,
    options: {},
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `workbuddy-provider-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  authFile = join(testDir, "workbuddy-desktop.info");
  process.env.WORKBUDDY_AUTH_FILE = authFile;
  process.env.OPENCODEX_HOME = join(testDir, "opencodex");
  isolatedCodexHome = installIsolatedCodexHome("ocx-workbuddy-codex-");
  writeFileSync(authFile, authPayload("fixture-access-one"));
});

afterEach(() => {
  if (originalAuthFile === undefined) delete process.env.WORKBUDDY_AUTH_FILE;
  else process.env.WORKBUDDY_AUTH_FILE = originalAuthFile;
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  globalThis.fetch = originalFetch;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(testDir, { recursive: true, force: true });
});

describe("WorkBuddy desktop credential import", () => {
  test("parses the desktop session and normalizes second-based expiry", () => {
    const expiresAtSeconds = Math.floor((Date.now() + 3_600_000) / 1000);
    const session = parseWorkBuddySession(authPayload("fixture-access", expiresAtSeconds));

    expect(session).toEqual({
      accessToken: "fixture-access",
      userId: "fixture-user-id",
      domain: "www.codebuddy.cn",
      expiresAt: expiresAtSeconds * 1000,
    });
  });

  test("rejects header injection without echoing the rejected value", () => {
    const canary = "line-break-canary";
    const raw = JSON.stringify({
      account: { uid: "fixture-user-id" },
      auth: { accessToken: `fixture-access\r\n${canary}`, expiresAt: Date.now() + 3_600_000 },
    });

    try {
      parseWorkBuddySession(raw);
      throw new Error("expected parser to reject the access token");
    } catch (error) {
      expect((error as Error).message).toBe("WorkBuddy access token is invalid.");
      expect((error as Error).message).not.toContain(canary);
    }
  });

  test("stores an external-session sentinel instead of the desktop refresh token", async () => {
    const credential = await loginWorkBuddy({});

    expect(credential.refresh).toBe(WORKBUDDY_EXTERNAL_SESSION_REFRESH);
    expect(credential.accountId).toBe("fixture-user-id");
    expect(JSON.stringify(credential)).not.toContain("desktop-owned-value");
  });

  test("re-imports a rotated desktop access token before each snapshot", async () => {
    const first = await getValidAccessTokenSnapshot("workbuddy");
    writeFileSync(authFile, authPayload("fixture-access-two"));
    const second = await getValidAccessTokenSnapshot("workbuddy");

    expect(first.accessToken).toBe("fixture-access-one");
    expect(first.requestHeaders?.["X-User-Id"]).toBe("fixture-user-id");
    expect(first.requestHeaders?.Authorization).toBeUndefined();
    expect(second.accessToken).toBe("fixture-access-two");
    expect(second.generation).not.toBe(first.generation);
    expect(getCredential("workbuddy")?.refresh).toBe(WORKBUDDY_EXTERNAL_SESSION_REFRESH);
    expect(readFileSync(join(process.env.OPENCODEX_HOME!, "auth.json"), "utf8")).not.toContain("desktop-owned-value");
  });

  test("replaces the single desktop account instead of retaining unusable sessions", async () => {
    await getValidAccessTokenSnapshot("workbuddy");
    writeFileSync(authFile, authPayload("fixture-access-other", Date.now() + 3_600_000, "fixture-user-other"));
    await getValidAccessTokenSnapshot("workbuddy");

    const accountSet = getAccountSet("workbuddy");
    expect(accountSet?.accounts).toHaveLength(1);
    expect(accountSet?.accounts[0]?.credential.accountId).toBe("fixture-user-other");
  });

  test("aborted refresh does not read or mutate the desktop session", async () => {
    const controller = new AbortController();
    controller.abort();
    rmSync(authFile);

    await expect(refreshWorkBuddyToken(WORKBUDDY_EXTERNAL_SESSION_REFRESH, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("honors the explicit auth-file override", () => {
    expect(workBuddyAuthPath()).toBe(authFile);
  });
});

describe("WorkBuddy request profile", () => {
  test("builds the required client headers with one request identity", () => {
    const session = parseWorkBuddySession(authPayload("fixture-access"));
    const headers = buildWorkBuddyRequestHeaders(session, {
      conversationId: "conversation-fixture",
      requestId: "request-fixture",
    });

    expect(headers).toMatchObject({
      "X-User-Id": "fixture-user-id",
      "X-Domain": "www.codebuddy.cn",
      "X-Product": "workbuddy-desktop",
      "X-IDE-Type": "workbuddy",
      "X-IDE-Name": "WorkBuddy",
      "X-Conversation-ID": "conversation-fixture",
      "X-Conversation-Request-ID": "request-fixture",
      "X-Conversation-Message-ID": "request-fixture",
      "X-Request-ID": "request-fixture",
    });
  });

  test("the generic adapter does not fabricate WorkBuddy headers without a routed provider", () => {
    const provider = deriveOAuthProviderConfig("workbuddy")!;
    provider.apiKey = "fixture-access-one";
    const request = createOpenAIChatAdapter(provider).buildRequest(parsedRequest());

    expect(request.url).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer fixture-access-one");
    expect(request.headers["X-User-Id"]).toBeUndefined();
  });
});

describe("WorkBuddy provider registry", () => {
  test("exposes the OAuth preset and its static model catalog", () => {
    const entry = PROVIDER_REGISTRY.find(provider => provider.id === "workbuddy");

    expect(listOAuthProviders()).toContain("workbuddy");
    expect(entry).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://copilot.tencent.com/v2",
      authKind: "oauth",
      defaultModel: "auto",
      liveModels: false,
      parallelToolCalls: true,
      models: [...WORKBUDDY_MODELS],
    });
    expect(deriveOAuthProviderConfig("workbuddy")?.headers).toBeUndefined();
  });

  test("credential conversion never imports fields outside the parsed session", () => {
    const credential = credentialFromWorkBuddySession({
      accessToken: "fixture-access",
      userId: "fixture-user-id",
      domain: "www.codebuddy.cn",
      expiresAt: Date.now() + 3_600_000,
    });
    expect(Object.keys(credential).sort()).toEqual(["access", "accountId", "expires", "refresh", "source"]);
  });
});

describe("WorkBuddy OAuth upstream 401 replay", () => {
  test("re-imports the rotated desktop token and retries once", async () => {
    const provider = deriveOAuthProviderConfig("workbuddy")!;
    const config: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "workbuddy",
      providers: { workbuddy: provider },
    };
    saveConfig(config);

    const observed: Array<{ authorization: string | null; userId: string | null; marker: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://copilot.tencent.com/v2/chat/completions") {
        const headers = new Headers(init?.headers);
        observed.push({
          authorization: headers.get("authorization"),
          userId: headers.get("x-user-id"),
          marker: headers.get("x-opencodex-client-profile"),
        });
        if (observed.length === 1) {
          writeFileSync(authFile, authPayload("fixture-access-two"));
          return new Response("rejected", { status: 401 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok after refresh" } }],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "workbuddy/glm-5.2", input: "hello", stream: false }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { output?: Array<{ type?: string; content?: Array<{ text?: string }> }> };
      expect(body.output?.find(item => item.type === "message")?.content?.[0]?.text).toBe("ok after refresh");
      expect(observed).toEqual([
        { authorization: "Bearer fixture-access-one", userId: "fixture-user-id", marker: null },
        { authorization: "Bearer fixture-access-two", userId: "fixture-user-id", marker: null },
      ]);
    } finally {
      server.stop(true);
    }
  });
});
