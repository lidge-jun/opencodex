import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleResponses } from "../../src/server/responses";
import { handleContextHistory } from "../../src/server/context-history";
import { getActiveTurnCount, tryAdmitTurn } from "../../src/server/lifecycle";
import { requestPolicyView, resolveApiAuth, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { saveConfig } from "../../src/config";
import { linkStorePath } from "../../src/link/paths";
import { readLinkStore, writeLinkStore } from "../../src/link/store";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resetCodexRoutingForManualSelection } from "../../src/codex/routing";
import { clearContextSessionOwnersForTests, getContextSessionOwner } from "../../src/codex/context-owner";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";

const principal = "principal-a";
const keyAdmission: DataPlaneAdmission = { kind: "configured", keyId: "k1", source: "dedicated", contextPrincipalId: principal };
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const destination = "https://chatgpt.com/backend-api/codex";
const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
let previousAdminToken: string | undefined;
let home = "";
let sent: Array<{ url: string; headers: Headers }> = [];
let failFirstAccount: string | undefined;
let releaseSpendHome: (() => void) | undefined;

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
  previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "ocx-context-owner-"));
  process.env.OPENCODEX_HOME = home; process.env.CODEX_HOME = home;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
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
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearContextSessionOwnersForTests(); clearAccountQuota(); clearThreadAccountMap(); clearCodexUpstreamHealth();
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
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

test("post-body admission revalidation consults the live link policy, not the request-entry snapshot", async () => {
  // The hub-link listener resolves its policy at request entry and again inside the context
  // relay's post-body revalidation. This drives that gate with the same requestPolicyView/
  // resolveApiAuth pair the listener uses, so a key revoked mid-request must stop dispatch.
  const LINK_KEY = "link-linked-revoke";
  const LINK_ID = "linked-key";
  const cfg = config();
  cfg.apiKeys = [{ id: LINK_ID, name: LINK_ID, key: LINK_KEY, createdAt: "2026-09-26T00:00:00.000Z" }];
  const linkIngress = { allowedKeyIds: new Set([LINK_ID]) };
  const linkPolicy = () => requestPolicyView(cfg, "opencodex-link.invalid", linkIngress);

  const linkRequest = (session: string) => new Request("http://opencodex-link.invalid/v1/alpha/notes/v2/read_file", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencodex-api-key": LINK_KEY,
      authorization: "Bearer caller-native-token",
      "chatgpt-account-id": "caller-account",
    },
    body: JSON.stringify({ context: { session_id: session } }),
  });
  const contextNotes = async (req: Request, admission: DataPlaneAdmission, revalidate: () => DataPlaneAdmission | null) => {
    const lease = tryAdmitTurn(); expect(lease).not.toBeNull();
    try {
      return await handleContextHistory(req, cfg, { model: "context_history", provider: "" },
        "alpha/notes/v2/read_file", lease!, admission, revalidate);
    } finally { lease?.release(); }
  };

  const entryPolicy = linkPolicy();
  const entryAdmission = resolveApiAuth(linkRequest("root-link"), entryPolicy);
  expect(entryAdmission?.contextPrincipalId).toBeDefined();
  // Record this principal's session owner the same way the ownership tests do: one model turn.
  expect((await model(cfg, "root-link", "side/gpt-5.5", requestHeaders("root-link"), entryAdmission!)).status).toBe(200);

  // Revoke the key mid-request: the next policy rebuild no longer resolves this credential.
  cfg.apiKeys = cfg.apiKeys?.filter(k => k.id !== LINK_ID);

  // Fixed wiring: the closure consults the live policy and the revoked key cannot dispatch.
  {
    const req = linkRequest("root-link");
    const denied = await contextNotes(req, entryAdmission!, () => resolveApiAuth(req, linkPolicy()));
    expect(denied.status).toBe(401);
  }
  // Pre-fix wiring kept the request-entry snapshot and still dispatched upstream.
  {
    const req = linkRequest("root-link");
    const admitted = await contextNotes(req, entryAdmission!, () => resolveApiAuth(req, entryPolicy));
    expect(admitted.status).toBe(200);
  }
  expect(sent.filter(row => row.url.includes("/alpha/"))).toHaveLength(1);
});

test("a real link listener refuses a revoked key after reading a delayed context body", async () => {
  const linkId = "linked-listener-key";
  const linkKey = "link-listener-revoke";
  const sessionId = "root-delayed-listener";
  const cfg = config();
  cfg.runtimeRole = "hub";
  cfg.apiKeys = [{ id: linkId, name: linkId, key: linkKey, createdAt: "2026-09-26T00:00:00.000Z" }];
  const admissionRequest = new Request("http://opencodex-link.invalid/v1/responses", {
    headers: { "x-opencodex-api-key": linkKey },
  });
  const entryPolicy = requestPolicyView(cfg, "opencodex-link.invalid", { allowedKeyIds: new Set([linkId]) });
  const admission = resolveApiAuth(admissionRequest, entryPolicy);
  expect(admission).not.toBeNull();
  expect((await model(cfg, sessionId, "side/gpt-5.5", requestHeaders(sessionId), admission!)).status).toBe(200);
  const upstreamBefore = sent.length;

  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "test-listener-admin-token";
  saveConfig(cfg);
  writeLinkStore(linkStorePath(), {
    version: 1, listenerPort: null,
    links: [{ id: "lnk_0123456789abcdef", alias: "delayed-test", direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: linkId,
      createdAt: "2026-09-26T00:00:00.000Z" }],
  });
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  const { startServer } = await import("../../src/server");
  const server = startServer(0);
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  try {
    const port = readLinkStore(linkStorePath()).listenerPort;
    expect(port).not.toBeNull();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode('{"context":'));
      },
    });
    const pending = originalFetch(`http://127.0.0.1:${port}/v1/alpha/notes/v2/read_file`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencodex-api-key": linkKey,
        authorization: "Bearer caller-native-token", "chatgpt-account-id": "caller-account" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const waitUntil = Date.now() + 5_000;
    while (getActiveTurnCount() === 0 && Date.now() < waitUntil) await Bun.sleep(5);
    expect(getActiveTurnCount()).toBe(1);

    const revoked = await originalFetch(new URL("/api/keys", server.url), {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-opencodex-api-key": "test-listener-admin-token" },
      body: JSON.stringify({ id: linkId }),
    });
    expect(revoked.status).toBe(200);
    bodyController!.enqueue(new TextEncoder().encode(`{"session_id":"${sessionId}"}}`));
    bodyController!.close();
    bodyController = undefined;
    expect((await pending).status).toBe(401);
    expect(sent).toHaveLength(upstreamBefore);
  } finally {
    try { bodyController?.close(); } catch { /* already closed after an early response */ }
    await server.stop(true);
  }
});
