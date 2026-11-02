import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth, clearAccountQuota, clearMainAccountInfoCache } from "../../src/codex/auth-api";
import { isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { resolveCodexAuthContext } from "../../src/codex/auth-context";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { codexCredentialMutationEpoch } from "../../src/codex/credential-mutation-epoch";
import { isMainAccountRefreshGrantRejected, MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../../src/codex/main-account";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { createTranslatorBudget, type TranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { codexAccountSelectionForTurn, tryAdmitTurn } from "../../src/server/lifecycle";
import { retryCodexPoolOnAlternateAccount } from "../../src/server/responses/core-codex-account";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/agent-task-recovery";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const POOL_ID = "alternate-cancel-pool";
let root: string;
let authPath: string;
let previousCodexHome: string | undefined;
let previousOcxHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let config: OcxConfig;
// Every upstream answer comes from the mocked fetch. Before #7418 the messages ingress also
// dialed a real Codex WebSocket first and only reached the mock on fallback, so each case
// waited on live DNS/TLS; under load that alone outran the 5s budget. Any dial is recorded
// and refused, and each case asserts there were none.
let webSocketDials: string[] = [];

function quotaRefusal(): Response {
  return Response.json({ error: { code: "usage_limit_reached", message: "fixture pool quota exhausted" } }, {
    status: 429, headers: { "retry-after": "60" },
  });
}

function refreshReply(terminal: boolean): Response {
  return terminal
    ? Response.json({ error: "invalid_grant" }, { status: 400 })
    : Response.json({ access_token: "fixture-refreshed-main", refresh_token: "fixture-rotated-main", expires_in: 3600 });
}

function completedInference(): Response {
  const response = {
    id: "resp_alternate_main", object: "response", status: "completed", model: "gpt-5.5",
    output: [{ id: "msg_alternate_main", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "alternate answered", annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  };
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function credentialState() {
  return {
    bytes: readFileSync(authPath, "utf8"),
    epoch: codexCredentialMutationEpoch(),
    refused: isMainAccountRefreshGrantRejected(),
    genericReauth: isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-alternate-main-cancel-"));
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  mkdirSync(codexHome);
  mkdirSync(ocxHome);
  previousCodexHome = process.env.CODEX_HOME;
  previousOcxHome = process.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = ocxHome;
  releaseSpendHome = acquireOwnedSpendHome();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(POOL_ID);
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  resetMainCodexAccountIdentityTrackingForTests();
  authPath = join(codexHome, "auth.json");
  writeFileSync(authPath, JSON.stringify({ tokens: {
    access_token: fakeChatGptJwt("fixture-main-account", { exp: 1 }),
    refresh_token: "fixture-main-grant", account_id: "fixture-main-account",
  } }));
  saveCodexAccountCredential(POOL_ID, {
    accessToken: "fixture-pool-access", refreshToken: "fixture-pool-grant",
    chatgptAccountId: "fixture-pool-account", expiresAt: Date.now() + 3_600_000,
  });
  config = {
    defaultProvider: "openai", activeCodexAccountId: POOL_ID,
    autoSwitchThreshold: 0, accountPoolStrategy: "fill-first",
    providers: { openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "pool",
      baseUrl: "https://chatgpt.com/backend-api/codex", upstreamWebsocket: false } },
    codexAccounts: [{ id: POOL_ID, label: "fixture pool" }],
  } as OcxConfig;
  globalThis.fetch = (async () => { throw new Error("unexpected mocked network call"); }) as typeof fetch;
  webSocketDials = [];
  globalThis.WebSocket = function refusedWebSocket(url: string | URL) {
    webSocketDials.push(String(url));
    throw new Error("unexpected WebSocket dial");
  } as unknown as typeof WebSocket;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(POOL_ID);
  clearAccountQuota();
  clearMainAccountInfoCache();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  resetMainCodexAccountIdentityTrackingForTests();
  setMainAccountPlan(null);
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOcxHome;
  removeTreeWithRetry(root);
});

type Turn = NonNullable<ReturnType<typeof tryAdmitTurn>>;
type Entry = "retry helper" | "messages ingress";

async function dispatch(entry: Entry, controller: AbortController, turn: Turn, budget: TranslatorBudget) {
  if (entry === "messages ingress") {
    // This is the actual ingress reconstruction: Claude creates a fresh Responses Request
    // without its own signal, and must carry the original caller cancellation in options.
    const req = new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: "openai/gpt-5.5", max_tokens: 64, stream: false,
        messages: [{ role: "user", content: "hello" }] }),
    });
    const response = await handleClaudeMessages(req, config, { model: "", provider: "" }, {
      requestId: crypto.randomUUID(), start: Date.now(), turnAdmissionLease: turn,
    });
    return { status: response.status, body: await response.text() };
  }
  const callerAuthHeaders = new Headers();
  const firstAuthCtx = await resolveCodexAuthContext(callerAuthHeaders, config, "pool", {
    modelId: "gpt-5.5", signal: controller.signal,
    beginCodexAccountSelection: codexAccountSelectionForTurn(turn),
  });
  expect(firstAuthCtx.kind).toBe("pool");
  if (firstAuthCtx.kind !== "pool") throw new Error("fixture did not select the first pool account");
  expect(firstAuthCtx.accountId).toBe(POOL_ID);
  const result = await retryCodexPoolOnAlternateAccount({
    callerAuthHeaders, config, firstAuthCtx, firstResponse: quotaRefusal(), outcomeStatus: 429,
    route: { providerName: "openai", modelId: "gpt-5.5", provider: config.providers.openai! },
    parsed: parseRequest({ model: "gpt-5.5", input: "hello", stream: false }),
    logCtx: { model: "", provider: "" },
    options: { abortSignal: controller.signal, translatorBudget: budget, turnAdmissionLease: turn },
    upstream: controller, connectMs: 10_000, stream: false, httpOnly: true,
  });
  if (result.kind !== "retried") return { kind: result.kind };
  expect(result.authCtx.kind).toBe("main-pool");
  return { kind: result.kind, status: result.upstreamResponse.status, body: await result.upstreamResponse.text() };
}

for (const entry of ["retry helper", "messages ingress"] as const) {
  describe(`pool to native main cancellation through ${entry}`, () => {
    for (const scenario of ["cancel-success", "cancel-terminal", "success-control"] as const) {
      test(scenario, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<Response>();
        const refreshes: string[] = [];
        const inference: string[] = [];
        const controller = new AbortController();
        const turn = tryAdmitTurn();
        expect(turn).not.toBeNull();
        const budget = createTranslatorBudget();
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.href === "https://auth.openai.com/oauth/token") {
            refreshes.push((JSON.parse(String(init?.body)) as { refresh_token?: string }).refresh_token ?? "");
            entered.resolve();
            // Deliberately ignore init.signal: a late rotating grant must be saved even
            // though caller cancellation still prevents subsequent inference.
            return release.promise;
          }
          if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/responses")) {
            const bearer = new Headers(init?.headers).get("authorization") ?? "";
            inference.push(bearer);
            if (bearer === "Bearer fixture-pool-access") return quotaRefusal();
            if (bearer === "Bearer fixture-refreshed-main") return completedInference();
            throw new Error("unexpected inference credential");
          }
          throw new Error(`unexpected mocked endpoint: ${url.origin}${url.pathname}`);
        }) as typeof fetch;
        const before = credentialState();
        expect(before.refused).toBe(false);
        expect(before.genericReauth).toBe(false);
        const outcome = dispatch(entry, controller, turn!, budget).then(
          value => ({ value }), error => ({ error }),
        );
        try {
          // A premature return reports a fixture failure instead of hanging on a gate.
          const reached = await Promise.race([
            entered.promise.then(() => ({ phase: "refresh" })),
            outcome.then(result => ({ phase: "finished-before-refresh", result })),
          ]);
          expect(reached).toEqual({ phase: "refresh" });
          expect(refreshes).toEqual(["fixture-main-grant"]);
          const initialInference = entry === "messages ingress" ? ["Bearer fixture-pool-access"] : [];
          expect(inference).toEqual(initialInference);
          if (scenario !== "success-control") controller.abort(new Error("fixture caller cancelled"));
          release.resolve(refreshReply(scenario === "cancel-terminal"));
          const result = await outcome;
          if (scenario === "success-control") {
            expect(result).toMatchObject({ value: { status: 200 } });
            expect(inference).toEqual([...initialInference, "Bearer fixture-refreshed-main"]);
            const after = credentialState();
            expect(after.bytes).toContain("fixture-rotated-main");
            expect(after.epoch).toBe(before.epoch + 1);
            expect(after.refused).toBe(false);
          } else {
            expect(inference).toEqual(initialInference);
            if (scenario === "cancel-success") {
              const after = credentialState();
              expect(JSON.parse(after.bytes).tokens).toMatchObject({
                access_token: "fixture-refreshed-main", refresh_token: "fixture-rotated-main",
              });
              expect(after.epoch).toBe(before.epoch + 1);
              expect(after.refused).toBe(false);
              expect(after.genericReauth).toBe(false);
            }
            if (scenario === "cancel-terminal") {
              // A cancelled terminal refusal must not poison later requests.
              expect(credentialState()).toEqual(before);
            }
          }
        } finally {
          release.resolve(refreshReply(false));
          await outcome;
          turn?.release();
          budget.dispose();
        }
        expect(webSocketDials).toEqual([]);
      });
    }
  });
}

test.each([false, true])("caller-owned retry from Pool to main scrubs continuation (affinity=%s)", async enabled => {
  const { rememberServingConversationStateIssuer, conversationStateBindingFromAuth, applyAccountChangeConversationStateScrub } = await import("../../src/server/responses/account-change-state");
  const { peekConversationStateIssuer } = await import("../../src/codex/routing/thread-affinity");
  const bearer = fakeChatGptJwt("fixture-caller", { exp: 4_000_000_000 });
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "session-id": "session", "thread-id": "thread" });
  config.codexPool = { requestOwnedAffinity: enabled };
  config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
  const turn = tryAdmitTurn();
  expect(turn).not.toBeNull();
  const controller = new AbortController();
  try {
    const authOptions = { modelId: "gpt-5.5", requestScopedMainCredential: true, primeCodexPoolQuotas: async () => {}, beginCodexAccountSelection: codexAccountSelectionForTurn(turn!) };
    const first = await resolveCodexAuthContext(headers, config, "pool", authOptions);
    const reused = await resolveCodexAuthContext(headers, config, "pool", authOptions);
    expect(first.affinityDecision?.move).toBe(enabled ? "new_bind" : "unbound");
    expect(reused.affinityDecision?.move).toBe(enabled ? "reused" : "unbound");
    expect(first.kind).toBe("pool");
    if (first.kind !== "pool") throw new Error("expected pool fixture");
    rememberServingConversationStateIssuer(first);
    config.pausedCodexAccountIds = [];
    let sentBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completedInference();
    }) as typeof fetch;
    const parsed = parseRequest({ model: "gpt-5.5", previous_response_id: "opaque-previous", input: "hello", stream: false });
    const result = await retryCodexPoolOnAlternateAccount({
      callerAuthHeaders: headers, config, firstAuthCtx: first, firstResponse: quotaRefusal(), outcomeStatus: 429,
      route: { providerName: "openai", modelId: "gpt-5.5", provider: config.providers.openai! },
      parsed, logCtx: { model: "", provider: "" },
      options: { abortSignal: controller.signal, translatorBudget: createTranslatorBudget(), turnAdmissionLease: turn! },
      upstream: controller, connectMs: 10_000, stream: false, httpOnly: true,
    });
    expect(result.kind).toBe("retried");
    if (result.kind !== "retried") throw new Error("expected alternate retry");
    expect(result.authCtx.kind).toBe("main");
    expect(sentBody?.previous_response_id).toBeUndefined();
    rememberServingConversationStateIssuer(result.authCtx, first.conversationStateKey);
    expect(peekConversationStateIssuer(first.conversationStateKey!)).toBe(MAIN_CODEX_ACCOUNT_ID);
    config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
    clearCodexUpstreamHealth();
    const next = await resolveCodexAuthContext(headers, config, "pool", authOptions);
    const binding = conversationStateBindingFromAuth(next)!;
    const body = { previous_response_id: "opaque-main-response" };
    expect(applyAccountChangeConversationStateScrub({ body, bindingKey: binding.bindingKey, servingAccountId: binding.accountId })).toBe(true);
    expect(body).not.toHaveProperty("previous_response_id");
  } finally { turn?.release(); }
});

test("regular Responses scrubs retained issuer on a manual main pin and on return to Pool", async () => {
  const { rememberServingConversationStateIssuer } = await import("../../src/server/responses/account-change-state");
  const { forgetRuntimeActiveCodexAccount, resetCodexRoutingForManualSelection } = await import("../../src/codex/routing/active-account");
  const { handleResponses } = await import("../../src/server/responses");
  const { rememberResponseState, clearResponseStateForTests } = await import("../../src/responses/state");
  const bearer = fakeChatGptJwt("fixture-pin-caller", { exp: 4_000_000_000 });
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json", "session-id": "session", "thread-id": "thread" });
  config.codexPool = { requestOwnedAffinity: true }; config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
  const turn = tryAdmitTurn();
  expect(turn).not.toBeNull();
  try {
    const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {}, beginCodexAccountSelection: codexAccountSelectionForTurn(turn!) };
    const first = await resolveCodexAuthContext(headers, config, "pool", options);
    const second = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(first.affinityDecision?.move).toBe("new_bind"); expect(second.affinityDecision?.move).toBe("reused");
    expect(first.kind).toBe("pool"); rememberServingConversationStateIssuer(second);
    resetCodexRoutingForManualSelection(MAIN_CODEX_ACCOUNT_ID);
    config.activeCodexAccountId = MAIN_CODEX_ACCOUNT_ID; config.activeCodexAccountPinned = MAIN_CODEX_ACCOUNT_ID; config.pausedCodexAccountIds = [];
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return completedInference(); }) as typeof fetch;
    clearResponseStateForTests();
    rememberResponseState({ model: "gpt-5.5", input: [{ role: "user", content: "earlier" }] }, { id: "opaque", status: "completed", output: [] }, undefined, { force: true });
    const request = (input: unknown = [{ role: "user", content: "hello" }]) => new Request("http://localhost/v1/responses", { method: "POST", headers,
      body: JSON.stringify({ model: "gpt-5.5", previous_response_id: "opaque", input, stream: false }) });
    const refusal = await handleResponses(request([{ role: "user", file_id: "opaque" }]), config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    expect(refusal.status).toBe(400); expect(await refusal.text()).toContain("uploaded file"); expect(sent).toHaveLength(0);
    const pinned = await handleResponses(request(), config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    const pinnedText = await pinned.text();
    if (pinned.status !== 200) throw new Error(`pinned status ${pinned.status}: ${pinnedText}`);
    expect(sent[0]?.previous_response_id).toBeUndefined();
    forgetRuntimeActiveCodexAccount();
    config.activeCodexAccountId = POOL_ID; config.activeCodexAccountPinned = undefined; config.pausedCodexAccountIds = [MAIN_CODEX_ACCOUNT_ID];
    const back = await handleResponses(request(), config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    expect(back.status).toBe(200); await back.text(); expect(sent[1]?.previous_response_id).toBeUndefined();
  } finally { clearResponseStateForTests(); turn?.release(); }
});

test.each([429, 503])("caller-owned Responses main quota refusal %s releases only its conversation binding", async refusalStatus => {
  const { handleResponses } = await import("../../src/server/responses");
  const { getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const { getCodexQuotaHealthSnapshot } = await import("../../src/codex/routing");
  const headers = new Headers({ authorization: `Bearer ${fakeChatGptJwt("owned-responses-failure")}`, "content-type": "application/json", "session-id": "s", "thread-id": "t" });
  config.codexPool = { requestOwnedAffinity: true }; config.pausedCodexAccountIds = [POOL_ID];
  config.accountPoolStrategy = "round-robin"; config.accountPoolStickyLimit = 1;
  const turn = tryAdmitTurn(); expect(turn).not.toBeNull();
  try {
    const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {}, beginCodexAccountSelection: codexAccountSelectionForTurn(turn!) };
    const first = await resolveCodexAuthContext(headers, config, "pool", options);
    const second = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(first.kind).toBe("main"); expect(first.affinityDecision?.move).toBe("new_bind"); expect(second.affinityDecision?.move).toBe("reused");
    config.pausedCodexAccountIds = [];
    let status = 200;
    globalThis.fetch = (async () => status === 200 ? completedInference() : refusalStatus === 429 ? quotaRefusal() : Response.json({ error: { code: "usage_limit_reached", message: "usage limit reached" } }, { status: 503, headers: { "retry-after": "600" } })) as typeof fetch;
    const makeRequest = () => new Request("http://localhost/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }) });
    const success = await handleResponses(makeRequest(), config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    expect(success.status).toBe(200); await success.text();
    expect(getThreadAffinity(first.affinityKey!, "shared")?.accountId).toBe(MAIN_CODEX_ACCOUNT_ID);
    status = 429;
    const failure = await handleResponses(makeRequest(), config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    expect(failure.status).toBe(refusalStatus); await failure.text();
    expect(getThreadAffinity(first.affinityKey!, "shared")).toBeUndefined();
    expect(getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "shared")).toBeNull();
    const next = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(next.affinityDecision?.move).toBe("rebound"); expect(next.affinityDecision?.reason).toBe("quota_refusal");
  } finally { turn?.release(); }
});

test("websocket terminal recorder releases a caller-owned main binding on quota refusal", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const headers = new Headers({ authorization: `Bearer ${fakeChatGptJwt("owned-ws-failure")}`, "content-type": "application/json", "session-id": "s", "thread-id": "t" });
  config.codexPool = { requestOwnedAffinity: true }; config.pausedCodexAccountIds = [POOL_ID];
  config.accountPoolStrategy = "round-robin"; config.accountPoolStickyLimit = 1;
  const turn = tryAdmitTurn(); expect(turn).not.toBeNull();
  try {
    const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {}, beginCodexAccountSelection: codexAccountSelectionForTurn(turn!) };
    const first = await resolveCodexAuthContext(headers, config, "pool", options);
    const second = await resolveCodexAuthContext(headers, config, "pool", options);
    expect(first.kind).toBe("main"); expect(first.affinityDecision?.move).toBe("new_bind"); expect(second.affinityDecision?.move).toBe("reused");
    config.pausedCodexAccountIds = [];
    globalThis.fetch = (async () => completedInference()) as typeof fetch;
    let record: ((status: "completed" | "failed" | "incomplete", httpStatusOverride?: number) => void) | undefined;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }) });
    const response = await handleResponses(req, config, { model: "", provider: "" }, { turnAdmissionLease: turn!, inboundTransport: "websocket", recordTerminalOutcomes: false, setTerminalOutcomeRecorder: fn => { record = fn; } });
    expect(response.status).toBe(200); await response.text();
    expect(record).toBeDefined();
    record!("incomplete", 429);
    expect(getThreadAffinity(first.affinityKey!, "shared")).toBeUndefined();
  } finally { turn?.release(); }
});

test("unkeyed caller-main 5xx does not inspect quota response body", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const account = await import("../../src/server/responses/core-codex-account");
  const { spyOn } = await import("bun:test");
  const headers = new Headers({ authorization: `Bearer ${fakeChatGptJwt("unkeyed-inspection")}`, "content-type": "application/json" });
  config.pausedCodexAccountIds = [POOL_ID];
  const turn = tryAdmitTurn(); expect(turn).not.toBeNull();
  const quotaInspector = spyOn(account, "shouldRetryCodexPoolAccountQuota").mockResolvedValue(false);
  try {
    globalThis.fetch = (async () => Response.json({ error: { message: "server error" } }, { status: 503, headers: { "retry-after": "600" } })) as typeof fetch;
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: false }) });
    const response = await handleResponses(req, config, { model: "", provider: "" }, { turnAdmissionLease: turn! });
    expect(response.status).toBe(503);
    expect(quotaInspector).not.toHaveBeenCalled();
    await response.text();
  } finally { quotaInspector.mockRestore(); turn?.release(); }
});
