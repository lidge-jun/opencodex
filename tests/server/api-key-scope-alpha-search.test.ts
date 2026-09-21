/**
 * Per-key model and provider scope on /v1/alpha/search (#5049).
 *
 * An account-qualified search model is resolved through the router and was
 * already covered. The two branches beside it were not: an unqualified model is
 * relayed verbatim to whichever ChatGPT account the upstream resolves to, and
 * the sidecar fallback spends the operator configured web-search backend. Both
 * bill a provider without ever naming a route.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { MODEL_NOT_ALLOWED_FOR_KEY, UNNAMED_DESTINATION_MODEL } from "../../src/server/admission-model-scope";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { handleSearch } from "../../src/server/search";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SCOPED_KEY = "ocx_data_" + "s".repeat(40);
const OPEN_KEY = "ocx_data_" + "t".repeat(40);
const SCOPED: DataPlaneAdmission = { kind: "configured", keyId: "scoped", source: "bearer" };
const UNSCOPED: DataPlaneAdmission = { kind: "configured", keyId: "open", source: "bearer" };
const CALLER_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "acct-123" });
const SEARCH_MODEL = "gpt-search-test";
const EXA_SEARCH_MODEL = "exa-search-test";

const TEST_DIR = join(import.meta.dir, ".tmp-alpha-search-scope");
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let codexHome: IsolatedCodexHome | null = null;
let upstreamCalls: string[] = [];

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codexHome = installIsolatedCodexHome("ocx-alpha-search-scope-");
  upstreamCalls = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    upstreamCalls.push(url);
    if (url.includes("exa.ai")) {
      return Response.json({
        results: [{ title: "OpenAI news", url: "https://openai.com/news", text: "Latest OpenAI news." }],
      });
    }
    return Response.json({ encrypted_output: null, output: "search result", results: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  codexHome?.restore();
  codexHome = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

type Scope = { allowedProviders?: string[]; allowedModels?: string[] };

function keys(scope: Scope): OcxConfig["apiKeys"] {
  return [
    { id: "scoped", name: "mail", key: SCOPED_KEY, createdAt: "2026-01-01T00:00:00.000Z", ...scope },
    { id: "open", name: "coding", key: OPEN_KEY, createdAt: "2026-01-01T00:00:00.000Z" },
  ];
}

/** A ChatGPT forward provider the caller authenticates directly, as codex does. */
function forwardConfig(scope: Scope): OcxConfig {
  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
      },
    },
    apiKeys: keys(scope),
  } as OcxConfig;
  saveConfig(config);
  return config;
}

/** No forward candidate at all, which is the only state the sidecar fallback runs in. */
function sidecarConfig(scope: Scope): OcxConfig {
  const config = {
    port: 0,
    defaultProvider: "groq",
    providers: {
      groq: { adapter: "openai-chat", baseUrl: "https://api.groq.example/v1", apiKey: "gsk-x" },
    },
    webSearchSidecar: { backend: "exa", exaApiKey: "exa-fixture-key", model: EXA_SEARCH_MODEL },
    apiKeys: keys(scope),
  } as unknown as OcxConfig;
  saveConfig(config);
  return config;
}

function logContext(): RequestLogContext {
  return { model: "web_search", provider: "unknown" } as RequestLogContext;
}

function forwardRequest(body: Record<string, unknown>, key = SCOPED_KEY): Request {
  return new Request("http://127.0.0.1/v1/alpha/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencodex-api-key": key,
      authorization: "Bearer " + CALLER_TOKEN,
      "chatgpt-account-id": "acct-123",
    },
    body: JSON.stringify(body),
  });
}

function sidecarRequest(body: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/v1/alpha/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": SCOPED_KEY },
    body: JSON.stringify(body),
  });
}

function searchBody(model?: string): Record<string, unknown> {
  return {
    id: "search-session",
    ...(model ? { model } : {}),
    commands: { search_query: [{ q: "OpenAI news" }] },
  };
}

async function denial(response: Response): Promise<{ type: string; model: string }> {
  const payload = await response.json() as { error: { type: string; model: string } };
  return payload.error;
}

test("an unqualified search model cannot reach a provider outside the scope", async () => {
  const response = await handleSearch(
    forwardRequest(searchBody(SEARCH_MODEL)),
    forwardConfig({ allowedProviders: ["anthropic"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  const error = await denial(response);
  expect(error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(error.model).toBe(SEARCH_MODEL);
  expect(upstreamCalls).toEqual([]);
});

test("an unqualified search model is checked as the destination it becomes", async () => {
  const response = await handleSearch(
    forwardRequest(searchBody(SEARCH_MODEL)),
    forwardConfig({ allowedModels: ["some-other-model"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect(upstreamCalls).toEqual([]);
});

test("a search body that names no model cannot satisfy a model list", async () => {
  const response = await handleSearch(
    forwardRequest(searchBody()),
    forwardConfig({ allowedModels: [SEARCH_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).model).toBe(UNNAMED_DESTINATION_MODEL);
});

test("the relay still runs when the scope names its destination", async () => {
  const response = await handleSearch(
    forwardRequest(searchBody(SEARCH_MODEL)),
    forwardConfig({ allowedProviders: ["openai"], allowedModels: [SEARCH_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]).toContain("/alpha/search");
});

test("the sidecar fallback refuses the backend it would have spent", async () => {
  const response = await handleSearch(
    sidecarRequest(searchBody(SEARCH_MODEL)),
    sidecarConfig({ allowedProviders: ["openai"] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(403);
  expect((await denial(response)).type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
  expect(upstreamCalls).toEqual([]);
});

test("the sidecar fallback is judged on the model the operator configured", async () => {
  const response = await handleSearch(
    sidecarRequest(searchBody(SEARCH_MODEL)),
    sidecarConfig({ allowedProviders: ["exa"], allowedModels: [SEARCH_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  // The caller's own selector is allowed; the backend runs a different model,
  // and that is the one the scope is applied to.
  expect(response.status).toBe(403);
  expect(upstreamCalls).toEqual([]);
});

test("an allowed sidecar backend still answers the search", async () => {
  const response = await handleSearch(
    sidecarRequest(searchBody(SEARCH_MODEL)),
    sidecarConfig({ allowedProviders: ["exa"], allowedModels: [EXA_SEARCH_MODEL] }),
    logContext(),
    undefined,
    SCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
  expect(upstreamCalls[0]).toContain("exa.ai");
});

test("a key with no scope keeps both search branches", async () => {
  const response = await handleSearch(
    forwardRequest(searchBody(SEARCH_MODEL), OPEN_KEY),
    forwardConfig({ allowedProviders: ["anthropic"] }),
    logContext(),
    undefined,
    UNSCOPED,
  );
  expect(response.status).toBe(200);
  expect(upstreamCalls).toHaveLength(1);
});
