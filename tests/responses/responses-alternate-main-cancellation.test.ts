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
const POOL_ID = "alternate-cancel-pool";
let root: string;
let authPath: string;
let previousCodexHome: string | undefined;
let previousOcxHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let config: OcxConfig;

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
      baseUrl: "https://chatgpt.com/backend-api/codex" } },
    codexAccounts: [{ id: POOL_ID, label: "fixture pool" }],
  } as OcxConfig;
  globalThis.fetch = (async () => { throw new Error("unexpected mocked network call"); }) as typeof fetch;
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
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
            refreshes.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
            entered.resolve();
            // Deliberately ignore init.signal: a late endpoint result must be fenced by
            // the credential owner even if the network operation does not stop on abort.
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
            // One aggregate assertion reports every forbidden side effect, including
            // terminal refusal that leaves bytes intact but poisons later requests.
            expect({ ...credentialState(), inference }).toEqual({ ...before, inference: initialInference });
          }
        } finally {
          release.resolve(refreshReply(false));
          await outcome;
          turn?.release();
          budget.dispose();
        }
      });
    }
  });
}
