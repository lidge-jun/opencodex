import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as authContext from "../../src/codex/auth-context";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAccountNeedsReauth } from "../../src/codex/auth-api";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, getCodexUpstreamHealth } from "../../src/codex/routing";
import { clearUpstreamHostHealth } from "../../src/codex/upstream-host-health";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import {
  createRequestExecutionBudget,
  CODEX_TEXT_GUARDED_BUDGET_POLICY,
  type RequestSendObserver,
} from "../../src/lib/request-execution-budget";
import { clearPoolRecoveryState } from "../../src/routing/probe-lease";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #6969 for native compact: a transient 5xx that survives the same-account ladder moves to one
 * alternate Pool account, as the regular Responses path does. Compact used to move only on 429/402.
 * The move is admitted under the alternate's identity, leaves the first answer intact when it is
 * refused, and records the first account once, as a transient failure.
 */

const WORK = "work";
const OTHER = "other";
const HOME_KEYS = ["HOME", "OPENCODEX_HOME", "CODEX_HOME"] as const;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

type Answer = () => Response | Promise<Response>;

const RealFetch = globalThis.fetch;
let home = "";
let previousHomes: Array<string | undefined> = [];
let savedProxyEnv: Record<string, string | undefined> = {};
let releaseSpendHome: (() => void) | undefined;
let sends: Array<string | null> = [];

function clearPoolState(): void {
  for (const id of [WORK, OTHER]) clearAccountNeedsReauth(id);
  clearCodexUpstreamHealth();
  clearUpstreamHostHealth();
  clearThreadAccountMap();
  clearPoolRotationState();
  clearPoolRecoveryState();
  clearAccountQuota();
}

beforeEach(() => {
  savedProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  previousHomes = HOME_KEYS.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-compact-overload-"));
  for (const key of HOME_KEYS) process.env[key] = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearPoolState();
  for (const id of [WORK, OTHER]) setAccountQuotaFromParsed(id, { weeklyPercent: 10 });
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
    [WORK, OTHER].map(id => [id, {
      credential: {
        accessToken: `${id}-access`,
        refreshToken: `${id}-grant`,
        expiresAt: Date.now() + 3_600_000,
        chatgptAccountId: `acc-${id}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
    }]),
  )));
  sends = [];
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = RealFetch;
  clearPoolState();
  for (const [index, key] of HOME_KEYS.entries()) {
    if (previousHomes[index] === undefined) delete process.env[key];
    else process.env[key] = previousHomes[index];
  }
  for (const key of PROXY_ENV_KEYS) {
    if (savedProxyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxyEnv[key];
  }
  removeTreeWithRetry(home);
});

/** Answers each compact send in order and records which credential it carried. */
function upstream(...answers: Answer[]): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push(new Headers(init?.headers).get("authorization"));
    const answer = answers[sends.length - 1] ?? answers.at(-1)!;
    return answer();
  }) as typeof fetch;
}

const overloaded = (headers: Record<string, string> = {}): Answer => () => Response.json(
  { error: { type: "server_error", code: "server_is_overloaded", message: "Our servers are currently overloaded." } },
  { status: 503, headers },
);
// A Retry-After past the wait ceiling ends the ladder after one send, leaving base sends for B.
const overloadedOnce = overloaded({ "retry-after": "600" });
const compacted: Answer = () => Response.json({ id: "cmp_1", object: "response.compaction", output: [] });

function poolConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
    },
    activeCodexAccountId: WORK,
    autoSwitchThreshold: 0,
    accountPoolStrategy: "round-robin",
    codexAccounts: [WORK, OTHER].map(id => ({ id, label: id })),
    ...extra,
  } as OcxConfig;
}

async function compact(options: {
  config?: OcxConfig;
  model?: string;
  budget?: ReturnType<typeof createRequestExecutionBudget>;
  logCtx?: RequestLogContext;
  signal?: AbortSignal;
} = {}) {
  const logCtx = options.logCtx ?? { model: "", provider: "" };
  const request = new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: options.model ?? "gpt-5.5", input: [{ role: "user", content: "compact this" }] }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const response = await handleResponsesCompact(request, options.config ?? poolConfig(), logCtx, undefined, undefined,
    options.budget ? { sendBudget: options.budget } : undefined);
  return { response, body: await response.text() };
}

function failures(accountId: string): number {
  return getCodexUpstreamHealth(accountId)?.consecutiveFailures ?? 0;
}

test("malformed retained compact input does not poison pooled account health", async () => {
  const config = poolConfig();
  const healthBefore = [WORK, OTHER].map(id => getCodexUpstreamHealth(id));
  upstream(compacted);
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = new Request("http://localhost/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: [{ type: "compaction", encrypted_content: "ocx2:invalid" }] }),
    });
    const response = await handleResponsesCompact(request, config, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(sends).toHaveLength(0);
    expect([WORK, OTHER].map(id => getCodexUpstreamHealth(id))).toEqual(healthBefore);
  }
  const { response } = await compact({ config });
  expect(response.status).toBe(200);
  expect(sends).toHaveLength(1);
  expect(failures(WORK)).toBe(0);
  expect(failures(OTHER)).toBe(0);
});

test("malformed retained compact input is rejected before a pooled credential refresh", async () => {
  // expiresAt inside the 60s refresh skew makes getValidCodexToken refresh, so an
  // unvalidated envelope would spend a token-refresh fetch before the 400.
  writeFileSync(join(home, "codex-accounts.json"), JSON.stringify(Object.fromEntries(
    [WORK, OTHER].map(id => [id, {
      credential: {
        accessToken: `${id}-access`,
        refreshToken: `${id}-grant`,
        expiresAt: Date.now() + 30_000,
        chatgptAccountId: `acc-${id}`,
      },
      generation: 1,
      refreshGrantFingerprint: createHash("sha256").update(`codex-refresh-grant:${id}-grant`).digest("hex"),
    }]),
  )));
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return Response.json({ access_token: "refreshed-access", refresh_token: "refreshed-grant", expires_in: 3600 });
  }) as typeof fetch;
  const request = new Request("http://localhost/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: [{ type: "compaction", encrypted_content: "ocx2:invalid" }] }),
  });

  const response = await handleResponsesCompact(request, poolConfig(), { model: "", provider: "" });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  expect(fetchCalls).toBe(0);
});

describe("native compact moves a surviving transient 5xx to one alternate account (#6969)", () => {
  test("A's ladder, then B from the final recovery reserve, serves the compact", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const { response } = await compact();
    expect(response.status).toBe(200);
    expect(sends).toEqual(["Bearer work-access", "Bearer work-access", "Bearer work-access", "Bearer other-access"]);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("B served from the remaining base allowance when A's ladder ended early", async () => {
    upstream(overloadedOnce, compacted);
    const { response } = await compact();
    expect(response.status).toBe(200);
    expect(sends).toEqual(["Bearer work-access", "Bearer other-access"]);
    expect(failures(WORK)).toBe(1);
  });

  test("B failing too returns B's answer and records each account once", async () => {
    upstream(overloaded(), overloaded(), overloaded(), overloaded());
    const { response, body } = await compact();
    expect(response.status).toBe(503);
    expect(body).toContain("server_is_overloaded");
    expect(sends).toHaveLength(4);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(1);
  });

  test("a pinned account never moves", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const { response } = await compact({ config: poolConfig({ codexAccountNamespaces: { side: WORK } }), model: "side/gpt-5.5" });
    expect(response.status).toBe(503);
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
  });

  test("a 5xx whose body confirms quota keeps today's path and does not take the transient move", async () => {
    const quota: Answer = () => Response.json({ error: { message: "You have hit your usage limit." } }, { status: 503 });
    upstream(quota, quota, quota, compacted);
    await compact();
    expect(sends).not.toContain("Bearer other-access");
  });

  test("B refused before sending by a spent budget leaves A's answer and outcome intact", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY, finalRecoveryAllowance: 0 });
    const { response, body } = await compact({ budget });
    expect(response.status).toBe(503);
    expect(body).toContain("server_is_overloaded");
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
    expect(failures(OTHER)).toBe(0);
  });

  test("a granted reservation whose physical start fails is released, and nothing is sent", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    let refunds = 0;
    let reserveStarted = false;
    const observer: RequestSendObserver = {
      enforced: true,
      charge: () => true,
      refund: () => { refunds += 1; },
      startRequest: () => {},
      beginReporter: () => ({ start() {}, rebindTarget: () => true, report() {}, close() {} }),
      // Base sends start; the reserve's physical start is refused.
      ensureSeed: target => {
        if (target.identityId === undefined) { reserveStarted = true; return undefined; }
        return { seed: true } as never;
      },
    };
    const budget = createRequestExecutionBudget(undefined, undefined, observer);
    const { response } = await compact({ budget });
    expect(reserveStarted).toBe(true);
    expect(refunds).toBe(1);
    expect(response.status).toBe(503);
    expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
    expect(failures(WORK)).toBe(1);
  });

  /**
   * Unequal identity balances against the real spend ledger. The identity cap is exactly what the
   * first account's own sends consume, so the alternate's send is admitted only if it is charged to
   * the alternate's identity; charged to the first account it would be refused and never sent.
   */
  async function ledgerCompact(identityCap: number, ...answers: Answer[]) {
    const { createSpendReservationLedger, DEFAULT_SPEND_RESERVATION_POLICY } = await import("../../src/lib/spend-reservation-ledger");
    const { createRequestSpendTracker } = await import("../../src/server/responses/request-spend");
    const ledger = createSpendReservationLedger({ salt: "compact-6969", policy: {
      ...DEFAULT_SPEND_RESERVATION_POLICY, identity: { maxTokens: identityCap }, pool: { maxTokens: 1_000 },
    } });
    const logCtx: RequestLogContext = { model: "", provider: "", spendInputEstimateTokens: 1, spendOutputCeilingTokens: 0 };
    const tracker = createRequestSpendTracker(logCtx, undefined, ledger);
    upstream(...answers);
    const config = poolConfig({ codexAccounts: [{ id: WORK, label: WORK, logLabel: "pa0a0a0" }, { id: OTHER, label: OTHER, logLabel: "pb0b0b0" }] } as Partial<OcxConfig>);
    const result = await compact({ config, logCtx, budget: createRequestExecutionBudget(undefined, undefined, tracker) });
    const used = (label: string) => {
      const snapshot = ledger.snapshot("identity", label);
      return snapshot ? snapshot.reserved + snapshot.settled + snapshot.unresolved : 0;
    };
    return { ...result, first: used("pa0a0a0"), alternate: used("pb0b0b0") };
  }

  test("on the base path the alternate is admitted against its own identity balance", async () => {
    const result = await ledgerCompact(1, overloadedOnce, compacted);
    expect(result.response.status).toBe(200);
    expect(sends).toEqual(["Bearer work-access", "Bearer other-access"]);
    expect(result.first).toBe(1);
    expect(result.alternate).toBe(1);
  });

  test("on the reserve path the alternate is admitted against its own identity balance", async () => {
    const result = await ledgerCompact(3, overloaded(), overloaded(), overloaded(), compacted);
    expect(result.response.status).toBe(200);
    expect(sends.at(-1)).toBe("Bearer other-access");
    expect(result.first).toBe(3);
    expect(result.alternate).toBe(1);
  });

  test("a dispatch guard refusing B before it leaves keeps A's answer and outcome", async () => {
    upstream(overloaded(), overloaded(), overloaded(), compacted);
    const original = authContext.createCodexAuthDispatchGuard;
    const guard = spyOn(authContext, "createCodexAuthDispatchGuard").mockImplementation((ctx, ...rest) => {
      if (ctx.kind === "pool" && ctx.accountId === OTHER) {
        return () => { throw new authContext.CodexPoolAccountCreditsOffError(OTHER, Date.now() + 60_000); };
      }
      return original(ctx, ...rest);
    });
    try {
      const { response, body } = await compact();
      expect(response.status).toBe(503);
      expect(body).toContain("server_is_overloaded");
      expect(sends.every(auth => auth === "Bearer work-access")).toBe(true);
      expect(failures(WORK)).toBe(1);
      expect(failures(OTHER)).toBe(0);
    } finally {
      guard.mockRestore();
    }
  });

  test("a caller cancelling while B is in flight records A once and answers 499", async () => {
    const abort = new AbortController();
    upstream(overloaded(), overloaded(), overloaded(), async () => {
      abort.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const { response } = await compact({ signal: abort.signal });
    expect(response.status).toBe(499);
    expect(failures(WORK)).toBe(1);
  });
});

test.each([false, true])("caller-owned compact Pool-to-main retry scrubs continuation (affinity=%s)", async enabled => {
  const { fakeChatGptJwt } = await import("../helpers/agent-task-recovery");
  const { rememberServingConversationStateIssuer } = await import("../../src/server/responses/account-change-state");
  const { peekConversationStateIssuer } = await import("../../src/codex/routing/thread-affinity");
  const bearer = fakeChatGptJwt("caller-test");
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json", "session-id": "test-session", "thread-id": "test-thread" });
  const config = poolConfig({ codexAccounts: [{ id: WORK, label: WORK }], pausedCodexAccountIds: ["__main__"], codexPool: { requestOwnedAffinity: enabled } });
  const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
  const first = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  const second = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision?.move).toBe(enabled ? "new_bind" : "unbound");
  expect(second.affinityDecision?.move).toBe(enabled ? "reused" : "unbound");
  expect(first.kind).toBe("pool");
  rememberServingConversationStateIssuer(second);
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push(new Headers(init?.headers).get("authorization"));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (sends.length === 1) config.pausedCodexAccountIds = [];
    return sends.length === 1 ? overloadedOnce() : compacted();
  }) as typeof fetch;
  const makeRequest = () => new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers,
    body: JSON.stringify({ model: "gpt-5.5", previous_response_id: "opaque-previous", input: [{ role: "user", content: "continue" }] }),
  });
  const response = await handleResponsesCompact(makeRequest(), config, { model: "", provider: "" });
  expect(sends.length).toBe(2);
  expect(response.status).toBe(200);
  expect(sends).toEqual(["Bearer work-access", `Bearer ${bearer}`]);
  expect(bodies[1]?.previous_response_id).toBeUndefined();
  expect(peekConversationStateIssuer(first.conversationStateKey!)).toBe("__main__");
  config.pausedCodexAccountIds = ["__main__"];
  sends = []; bodies.length = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sends.push(new Headers(init?.headers).get("authorization"));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return compacted();
  }) as typeof fetch;
  const next = await handleResponsesCompact(makeRequest(), config, { model: "", provider: "" });
  expect(next.status).toBe(200);
  expect(sends).toEqual(["Bearer work-access"]);
  expect(bodies[0]?.previous_response_id).toBeUndefined();
});

test("caller-owned compact scrubs Pool to manually pinned main and back", async () => {
  const { fakeChatGptJwt } = await import("../helpers/agent-task-recovery");
  const { rememberServingConversationStateIssuer } = await import("../../src/server/responses/account-change-state");
  const bearer = fakeChatGptJwt("pin-caller");
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json", "session-id": "session", "thread-id": "thread" });
  const config = poolConfig({ codexAccounts: [{ id: WORK, label: WORK }], pausedCodexAccountIds: ["__main__"], codexPool: { requestOwnedAffinity: true } });
  const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
  const first = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  const second = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.affinityDecision?.move).toBe("new_bind"); expect(second.affinityDecision?.move).toBe("reused");
  expect(first.kind).toBe("pool"); rememberServingConversationStateIssuer(second);
  const { resetCodexRoutingForManualSelection } = await import("../../src/codex/routing/active-account");
  resetCodexRoutingForManualSelection("__main__");
  config.activeCodexAccountId = "__main__"; config.activeCodexAccountPinned = "__main__"; config.pausedCodexAccountIds = [];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return compacted();
  }) as typeof fetch;
  const request = (input: unknown = [{ role: "user", content: "continue" }]) => new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", previous_response_id: "opaque", input }),
  });
  const refusal = await handleResponsesCompact(request([{ role: "user", file_id: "opaque" }]), config, { model: "", provider: "" });
  expect(refusal.status).toBe(400); expect(bodies).toHaveLength(0);
  const pinned = await handleResponsesCompact(request(), config, { model: "", provider: "" });
  expect(pinned.status).toBe(200); expect(bodies[0]?.previous_response_id).toBeUndefined();
  config.activeCodexAccountId = WORK; config.activeCodexAccountPinned = undefined; config.pausedCodexAccountIds = ["__main__"];
  const back = await handleResponsesCompact(request(), config, { model: "", provider: "" });
  expect(back.status).toBe(200); expect(bodies[1]?.previous_response_id).toBeUndefined();
});

test("caller-owned compact main 429 releases only its conversation binding", async () => {
  const { fakeChatGptJwt } = await import("../helpers/agent-task-recovery");
  const { getThreadAffinity } = await import("../../src/codex/routing/thread-affinity");
  const { getCodexQuotaHealthSnapshot } = await import("../../src/codex/routing");
  const bearer = fakeChatGptJwt("owned-compact-failure");
  const headers = new Headers({ authorization: `Bearer ${bearer}`, "content-type": "application/json", "session-id": "s", "thread-id": "t" });
  const config = poolConfig({ codexAccounts: [{ id: WORK, label: WORK }], pausedCodexAccountIds: [WORK], codexPool: { requestOwnedAffinity: true } });
  const options = { requestScopedMainCredential: true, modelId: "gpt-5.5", primeCodexPoolQuotas: async () => {} };
  const first = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  const second = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  expect(first.kind).toBe("main"); expect(first.affinityDecision?.move).toBe("new_bind");
  expect(second.affinityDecision?.move).toBe("reused");
  config.pausedCodexAccountIds = [];
  let status = 200;
  globalThis.fetch = (async () => status === 200 ? compacted() : Response.json({ error: { message: "quota exceeded" } }, { status: 429, headers: { "retry-after": "600" } })) as typeof fetch;
  const makeRequest = () => new Request("http://localhost/v1/responses/compact", { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", input: [{ role: "user", content: "continue" }] }) });
  expect((await handleResponsesCompact(makeRequest(), config, { model: "", provider: "" })).status).toBe(200);
  expect(getThreadAffinity(first.affinityKey!, "shared")?.accountId).toBe("__main__");
  status = 429;
  expect((await handleResponsesCompact(makeRequest(), config, { model: "", provider: "" })).status).toBe(429);
  expect(getThreadAffinity(first.affinityKey!, "shared")).toBeUndefined();
  expect(getCodexQuotaHealthSnapshot("__main__", "shared")).toBeNull();
  const next = await authContext.resolveCodexAuthContext(headers, config, "pool", options);
  expect(next.affinityDecision?.move).toBe("rebound");
  expect(next.affinityDecision?.reason).toBe("quota_refusal");
});
