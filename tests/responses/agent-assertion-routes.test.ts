import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { saveConfig } from "../../src/config";
import { AGENT_ASSERTION_HEADER, AGENT_ASSERTION_UNSUPPORTED_CODE } from "../../src/lib/authorization-scheme";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

// Every case starts a real server; on Windows its config-dir ACL work alone can exceed 5 s.
setDefaultTimeout(SERVER_BUDGET_MS);

/**
 * Codex 0.164 runtime agent instances (openai/codex#55402, #55636) end to end. dual_header keeps
 * working with its Bearer and forwards x-openai-agent-assertion only on first-party Direct.
 * assertion_only (Authorization: AgentAssertion) is refused with a typed error before any pool,
 * routed, or admission decision, so no other credential is ever sent in its place.
 */
const inspectNativeCodexOwnership = ownedServiceHomeInspection("agent assertion routes test");
const ACCOUNT = "agent-assertion-route-account";
const CALLER = fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
const ASSERTION = fakeChatGptJwt({ agent: "runtime-agent-assertion-fixture", "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
const ADMISSION_KEY = "ocx_data_agent_assertion_route_fixture";

type Seen = { path: string; authorization: string | null; assertion: string | null };

function completed(id: string): Response {
  return Response.json({
    id, object: "response", status: "completed", model: "gpt-5.5",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

describe("Codex runtime agent assertion routes", () => {
  const originalFetch = globalThis.fetch;
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;
  let seen: Seen[] = [];
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let server: ReturnType<typeof startServer> | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-agent-assertion-codex-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-agent-assertion-"));
    process.env.OPENCODEX_HOME = testDir;
    seen = [];
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get("authorization"),
          assertion: req.headers.get(AGENT_ASSERTION_HEADER),
        });
        return completed("resp_agent_assertion");
      },
    });
    const target = upstream.url;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/backend-api/codex")) {
        return originalFetch(new URL(`/chatgpt${url.pathname.slice("/backend-api/codex".length)}`, target), init);
      }
      if (url.hostname === "gateway.example.test") return originalFetch(new URL(`/gateway${url.pathname}`, target), init);
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(async () => {
    if (server) await server.stop(true);
    server = undefined;
    upstream?.stop(true);
    globalThis.fetch = originalFetch;
    process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) await removeTreeWithRetry(testDir);
  });

  function start(config: Partial<OcxConfig>): URL {
    saveConfig({ port: 0, ...config } as OcxConfig);
    server = startServer(0, { inspectNativeCodexOwnership });
    return new URL(server.url);
  }

  function post(base: URL, headers: Record<string, string>, model = "gpt-5.5"): Promise<Response> {
    return fetch(new URL("/v1/responses", base), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, stream: false, store: false, input: "hello" }),
    });
  }

  async function expectRefused(response: Response): Promise<void> {
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe(AGENT_ASSERTION_UNSUPPORTED_CODE);
    expect(text).not.toContain(ASSERTION);
  }

  function expectNoAssertionPersisted(): void {
    for (const path of filesUnder(testDir)) expect(readFileSync(path, "latin1")).not.toContain(ASSERTION);
  }

  const direct = { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
    codexAccountMode: "direct", upstreamWebsocket: false,
  } } as unknown as OcxConfig["providers"];
  const pooled = { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
    codexAccountMode: "pool", upstreamWebsocket: false,
  } } as unknown as OcxConfig["providers"];

  function savePoolAccount(): Partial<OcxConfig> {
    saveCodexAccountCredential("pool-account", {
      accessToken: "pool-account-token", refreshToken: "pool-account-refresh",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: "pool-account-uuid",
    });
    return {
      activeCodexAccountId: "pool-account",
      codexAccounts: [{ id: "pool-account", email: "pool@example.test", chatgptAccountId: "pool-account-uuid", isMain: false }],
    } as Partial<OcxConfig>;
  }

  test("dual_header on Direct forwards the caller Bearer with its assertion", async () => {
    const base = start({ defaultProvider: "openai", providers: direct });
    const response = await post(base, {
      authorization: `Bearer ${CALLER}`, "chatgpt-account-id": ACCOUNT, [AGENT_ASSERTION_HEADER]: ASSERTION,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toEqual([{ path: "/chatgpt/responses", authorization: `Bearer ${CALLER}`, assertion: ASSERTION }]);
    expectNoAssertionPersisted();
  });

  test("dual_header on a pooled account sends the pool Bearer and strips the assertion", async () => {
    const base = start({ defaultProvider: "openai", providers: pooled, ...savePoolAccount() });
    const response = await post(base, {
      authorization: `Bearer ${CALLER}`, "chatgpt-account-id": ACCOUNT, [AGENT_ASSERTION_HEADER]: ASSERTION,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(seen).toEqual([{ path: "/chatgpt/responses", authorization: "Bearer pool-account-token", assertion: null }]);
    expectNoAssertionPersisted();
  });

  test("dual_header with an admission Bearer substitutes stored main and drops the assertion", async () => {
    const stored = fakeChatGptJwt({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "stored-main-account" } });
    writeFileSync(join(isolatedCodexHome!.path, "auth.json"),
      JSON.stringify({ tokens: { access_token: stored, account_id: "stored-main-account" } }));
    const base = start({
      hostname: "0.0.0.0",
      defaultProvider: "openai",
      providers: direct,
      apiKeys: [{ id: "agent-key", name: "agent", key: ADMISSION_KEY, createdAt: "2026-10-21T00:00:00.000Z" }],
    } as unknown as Partial<OcxConfig>);
    await waitForNativeMainStartupGate();
    const response = await post(base, { authorization: `Bearer ${ADMISSION_KEY}`, [AGENT_ASSERTION_HEADER]: ASSERTION });
    expect(response.status).toBe(200);
    await response.text();
    // The assertion was sent beside the admission key, so it never rides with the stored credential.
    expect(seen).toEqual([{ path: "/chatgpt/responses", authorization: `Bearer ${stored}`, assertion: null }]);
    expectNoAssertionPersisted();
  });

  test("assertion_only on a pooled account is refused without spending the pool credential", async () => {
    const base = start({ defaultProvider: "openai", providers: pooled, ...savePoolAccount() });
    await expectRefused(await post(base, { authorization: `AgentAssertion ${ASSERTION}`, "chatgpt-account-id": ACCOUNT }));
    expect(seen).toEqual([]);
    expectNoAssertionPersisted();
  });

  test("assertion_only on Direct and on a routed provider is refused before any upstream call", async () => {
    const base = start({
      defaultProvider: "openai",
      providers: {
        ...direct,
        gateway: {
          adapter: "openai-responses", baseUrl: "https://gateway.example.test/v1", authMode: "key",
          apiKey: "sk-routed-provider-key", models: ["gateway-model"], allowPrivateNetwork: true,
        },
      } as unknown as OcxConfig["providers"],
    });
    await expectRefused(await post(base, { authorization: `AgentAssertion ${ASSERTION}` }));
    await expectRefused(await post(base, { authorization: `AgentAssertion ${ASSERTION}` }, "gateway/gateway-model"));
    expect(seen).toEqual([]);
    expectNoAssertionPersisted();
  });

  test("a remote bind refuses assertion_only with the typed error whether or not the caller is admitted", async () => {
    const base = start({
      hostname: "0.0.0.0",
      defaultProvider: "openai",
      providers: pooled,
      ...savePoolAccount(),
      apiKeys: [{ id: "agent-key", name: "agent", key: ADMISSION_KEY, createdAt: "2026-10-21T00:00:00.000Z" }],
    } as unknown as Partial<OcxConfig>);
    await expectRefused(await post(base, { "x-opencodex-api-key": ADMISSION_KEY, authorization: `AgentAssertion ${ASSERTION}` }));
    await expectRefused(await post(base, { authorization: `AgentAssertion ${ADMISSION_KEY}` }));
    expect(seen).toEqual([]);
  });
});
