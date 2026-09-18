import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleResponses } from "../../src/server/responses";
import { handleContextHistory } from "../../src/server/context-history";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resetCodexRoutingForManualSelection } from "../../src/codex/routing";
import { clearContextSessionOwnersForTests, getContextSessionOwner } from "../../src/codex/context-owner";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";

const principal = "principal-a";
const keyAdmission: DataPlaneAdmission = { kind: "configured", keyId: "k1", source: "dedicated", contextPrincipalId: principal };
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const destination = "https://chatgpt.com/backend-api/codex";
const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let home = "";
let sent: Array<{ url: string; headers: Headers }> = [];
let failFirstAccount: string | undefined;

function install(id: string, owner: string, token = `${id}-token`): void {
  saveCodexAccountCredential(id, { accessToken: token, refreshToken: `${id}-refresh`,
    chatgptAccountId: owner, expiresAt: Date.now() + 3600_000 });
  setAccountQuotaFromParsed(id, { weeklyPercent: 20 });
}

function config(): OcxConfig {
  return { port: 0, defaultProvider: "openai", activeCodexAccountId: "pool-b",
    autoSwitchThreshold: 95, accountPoolStrategy: "fill-first", emptyCompletionRetry: false,
    codexAccountNamespaces: { side: "pool-a" },
    codexAccounts: [{ id: "pool-a", isMain: false }, { id: "pool-b", isMain: false }],
    providers: { openai: { adapter: "openai-responses", baseUrl: destination,
      authMode: "forward", codexAccountMode: "pool" } } };
}

function requestHeaders(session: string, bearer = "caller-native-token", account = "caller-account"): Headers {
  return new Headers({ "content-type": "application/json", authorization: `Bearer ${bearer}`,
    "chatgpt-account-id": account, "session-id": session, "thread-id": session });
}

async function model(cfg: OcxConfig, session: string, name = "side/gpt-5.5", headers = requestHeaders(session), admission: DataPlaneAdmission = keyAdmission): Promise<Response> {
  const lease = tryAdmitTurn(); expect(lease).not.toBeNull();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers,
      body: JSON.stringify({ model: name, input: "hello", stream: false }) }), cfg,
      { model: "", provider: "" }, { turnAdmissionLease: lease!, admission });
    const text = await response.text();
    return new Response(text, { status: response.status, headers: response.headers });
  } finally { lease?.release(); }
}

async function notes(cfg: OcxConfig, session: string, headers = requestHeaders(session), admission: DataPlaneAdmission = keyAdmission): Promise<Response> {
  const lease = tryAdmitTurn(); expect(lease).not.toBeNull();
  try {
    return await handleContextHistory(new Request("http://localhost/v1/alpha/notes/v2/read_file", {
      method: "POST", headers, body: JSON.stringify({ context: { session_id: session } }),
    }), cfg, { model: "context_history", provider: "" }, "alpha/notes/v2/read_file", lease!, admission);
  } finally { lease?.release(); }
}

function setContextFeature(enabled: boolean): void {
  writeFileSync(join(home, "config.toml"), enabled ? "[features]\ncontext_management.experimental_mode = true\n" : "model = \"gpt-5.5\"\n");
  resetContextRelayActivationForTests();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME; previousCodexHome = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-context-owner-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  setContextFeature(true);
  clearContextSessionOwnersForTests(); clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
  for (const id of ["pool-a", "pool-b", "__main__"]) clearAccountNeedsReauth(id);
  install("pool-a", "physical-a"); install("pool-b", "physical-b");
  sent = []; failFirstAccount = undefined;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const headers = new Headers(init?.headers); sent.push({ url, headers });
    if (url === `${destination}/responses`) {
      if (headers.get("chatgpt-account-id") === failFirstAccount) {
        failFirstAccount = undefined;
        return Response.json({ error: { message: "usage limit reached", type: "usage_limit_reached" } }, { status: 429 });
      }
      return Response.json({ id: "response-owned", object: "response", status: "completed",
        output: [{ id: "message-owned", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "ready", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }
    if (url === `${destination}/alpha/notes/v2/read_file`) return Response.json({ value: "same account" });
    throw new Error(`Unexpected test request: ${url}`);
  }, { preconnect: originalFetch.preconnect });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearContextSessionOwnersForTests(); clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
});

test("successful explicit account A owns context while active B remains selected", async () => {
  const cfg = config(); resetCodexRoutingForManualSelection("pool-b");
  const response = await model(cfg, "root-explicit");
  expect(response.status).toBe(200);
  expect(getContextSessionOwner(principal, "root-explicit", destination)).toMatchObject({ kind: "stored", accountId: "pool-a", ambiguous: false });
  expect((await notes(cfg, "root-explicit")).status).toBe(200);
  expect(sent.map(row => row.headers.get("chatgpt-account-id"))).toEqual(["physical-a", "physical-a"]);
  expect(cfg.activeCodexAccountId).toBe("pool-b");
  // These synthetic tokens carry no user claim, so a replaced credential is a different owner
  // fingerprint: history waits for an accepted model turn instead of trusting the workspace id.
  install("pool-a", "physical-a", "renewed-a-token");
  expect((await notes(cfg, "root-explicit")).status).toBe(409);
  install("pool-a", "replacement-a");
  expect((await notes(cfg, "root-explicit")).status).toBe(409);
  clearContextSessionOwnersForTests();
  expect((await notes(cfg, "root-explicit")).status).toBe(409);
  expect(sent).toHaveLength(2);
});

test("with the experimental feature off no relay state is built and no endpoint answers", async () => {
  const cfg = config(); resetCodexRoutingForManualSelection("pool-b");
  setContextFeature(false);
  expect((await model(cfg, "root-disabled")).status).toBe(200);
  // The model turn still serves normally; what it must not do is build ownership for a relay
  // that is switched off, and the endpoints must not answer.
  expect(getContextSessionOwner(principal, "root-disabled", destination)).toBeUndefined();
  expect((await notes(cfg, "root-disabled")).status).toBe(404);
  expect(sent.filter(row => row.url.includes("/alpha/"))).toHaveLength(0);
});

test("failed account A then successful B records only the serving account", async () => {
  const cfg = config(); cfg.activeCodexAccountId = "pool-a";
  resetCodexRoutingForManualSelection("pool-a"); failFirstAccount = "physical-a";
  const response = await model(cfg, "root-retry", "gpt-5.5");
  expect(response.status).toBe(200);
  expect(sent.map(row => row.headers.get("chatgpt-account-id"))).toEqual(["physical-a", "physical-b"]);
  expect(getContextSessionOwner(principal, "root-retry", destination)).toMatchObject({ kind: "stored", accountId: "pool-b", ambiguous: false });
  expect((await notes(cfg, "root-retry")).status).toBe(200);
  expect(sent.at(-1)!.headers.get("chatgpt-account-id")).toBe("physical-b");
});

test("Direct caller context never borrows stored login or proxy admission", async () => {
  const cfg = config(); cfg.providers.openai.codexAccountMode = "direct";
  expect((await model(cfg, "root-caller", "gpt-5.5")).status).toBe(200);
  expect(getContextSessionOwner(principal, "root-caller", destination)?.kind).toBe("caller");
  expect((await notes(cfg, "root-caller")).status).toBe(200);
  expect(sent.map(row => row.headers.get("authorization"))).toEqual(["Bearer caller-native-token", "Bearer caller-native-token"]);
  const admission = { kind: "environment", source: "bearer", contextPrincipalId: principal } as const;
  expect((await notes(cfg, "root-caller", requestHeaders("root-caller", "ocx_data_test_key"), admission)).status).toBe(409);
  expect(sent).toHaveLength(2);
});

test("Direct proxy-bearer model and notes use stored main without leaking the proxy secret", async () => {
  const cfg = config(); cfg.providers.openai.codexAccountMode = "direct";
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: token, account_id: "physical-main" } }));
  const admission = { kind: "environment", source: "bearer", contextPrincipalId: principal } as const;
  const headers = requestHeaders("root-proxy", "ocx_data_test_key", "untrusted-account");
  expect((await model(cfg, "root-proxy", "gpt-5.5", headers, admission)).status).toBe(200);
  expect(getContextSessionOwner(principal, "root-proxy", destination)).toMatchObject({ kind: "stored", accountId: "__main__" });
  expect((await notes(cfg, "root-proxy", headers, admission)).status).toBe(200);
  expect(sent.map(row => row.headers.get("authorization"))).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
  expect(sent.every(row => row.headers.get("chatgpt-account-id") === "physical-main")).toBe(true);
});
