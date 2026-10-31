/**
 * Admission-scope transport end-to-end for the Advisor sidecar.
 *
 * A scoped data-plane key's admission scope is resolved once at request preparation, carried
 * on the capability-authenticated Advisor loopback consult as the
 * x-opencodex-advisor-admission-scope header, and applied to the Advisor's OWN destination
 * check — not re-resolved against whatever the key looks like at consult time.
 *
 * Pairing is load-bearing: the denied case proves a caller whose key cannot reach the
 * advisor's provider gets the consult refused with zero calls to the expert upstream, and
 * the allowed control proves the same path consults normally when the key covers it. The
 * earlier seam tests (advisor-internal-authority.test.ts) stop at the factory boundary; this
 * file drives the real preparation → loopback → final route scope check chain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { handleResponses } from "../../src/server/responses/core";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { collectSse } from "../helpers/responses-conformance";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import {
  ADVISOR_ADMISSION_SCOPE_HEADER,
  decodeAdvisorAdmissionScope,
  encodeAdvisorAdmissionScope,
} from "../../src/server/advisor-admission-scope";
import {
  ADVISOR_INTERNAL_CAPABILITY_HEADER,
  internalCallCapability,
} from "../../src/lib/local-internal-call-capability";
import { advisorBaseUrl } from "../../src/advisor/consult";
import { MODEL_NOT_ALLOWED_FOR_KEY } from "../../src/server/admission-model-scope";
import { resolveDataPlaneAdmissionSecret, type DataPlaneAdmission } from "../../src/server/auth-cors";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
afterEach(() => {
  try {
    releaseSpendHome?.();
  } finally {
    // Restore fetch even when the spend-home release throws, so a teardown failure
    // cannot leak the interceptor into the next test and mask the original failure.
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  }
});

const logCtx = { model: "", provider: "" };
const ADVISOR_ADVICE = "Sequence the fix: token store first, then the refresh window.";

const advisorCallFrames = [
  { choices: [{ delta: { content: "Let me consult the expert." }, finish_reason: null }] },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_adv_scope",
          type: "function",
          function: { name: "advisor", arguments: JSON.stringify({ question: "Where do I start?" }) },
        }],
      },
      finish_reason: null,
    }],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const plainFrames = (text: string) => [
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
];

function sse(frames: unknown[]): Response {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 },
  }), { headers: { "Content-Type": "application/json" } });
}

interface ConsultRecord {
  scopeHeader: string | null;
  status: number;
  errorType: string | undefined;
}

/**
 * The advisor's loopback consultation re-enters through /v1/chat/completions — serve it
 * in-process through the real handler so capability authentication, scope-header decoding,
 * and the final route scope check all execute for real. Any other global fetch is a defect:
 * the only permitted external legs are the per-provider fetch overrides on the config.
 */
function loopbackInterceptor(config: OcxConfig, consults: ConsultRecord[]) {
  // Exact loopback consult target only: matching on a substring would let an external
  // origin or a query-string bypass ("/v1/chat/completions?x") reach the real handler.
  const expected = `${advisorBaseUrl(config)}/v1/chat/completions`;
  let consultSeq = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== expected) {
      throw new Error(`unexpected fetch during scope-transport test: ${url} (expected ${expected})`);
    }
    const headers = new Headers(init?.headers);
    consultSeq += 1;
    const requestId = `scope-transport-consult-${consultSeq}`;
    // Mirror the listener: the presented data-plane key resolves to the consult's own
    // admission — the host token — before the handler's scope checks run.
    const presented = headers.get("x-opencodex-api-key");
    const admission = presented
      ? resolveDataPlaneAdmissionSecret(presented, config, "x-api-key") ?? undefined
      : undefined;
    const res = await handleChatCompletions(new Request(url, init), config, logCtx, {
      requestId,
      start: Date.now(),
      ...(admission ? { admission } : {}),
    });
    let errorType: string | undefined;
    try { errorType = (await res.clone().json() as { error?: { type?: string } }).error?.type; } catch { /* not JSON */ }
    consults.push({
      scopeHeader: headers.get(ADVISOR_ADMISSION_SCOPE_HEADER),
      status: res.status,
      errorType,
    });
    return res;
  }) as typeof fetch;
}

function scopedConfig(scope: { providers: string[]; models: string[] }, workerBodies: string[], expertCalls: string[]): OcxConfig {
  let leg = 0;
  const legs = [advisorCallFrames, plainFrames("Following the advice, if any.")];
  const config = {
    port: 10100,
    providers: {
      worker: {
        adapter: "openai-chat",
        baseUrl: "https://worker.test/v1",
        apiKey: "worker-key",
        models: ["deepseek-v4"],
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          workerBodies.push(String(init?.body));
          const events = legs[Math.min(leg, legs.length - 1)]!;
          leg += 1;
          return sse(events);
        }) as typeof fetch,
      },
      expert: {
        adapter: "openai-chat",
        baseUrl: "https://expert.test/v1",
        apiKey: "expert-key",
        models: ["gpt-6-astra"],
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          expertCalls.push(String(init?.body));
          return chatCompletion(ADVISOR_ADVICE);
        }) as typeof fetch,
      },
    },
    advisor: { enabled: true, model: "expert/gpt-6-astra", contextSharingConsent: "v1", effort: "high", policy: "manual" },
    apiKeys: [{
      id: "caller",
      name: "caller",
      key: "ocx_data_" + "c".repeat(40),
      createdAt: "2026-01-01T00:00:00.000Z",
      allowedProviders: scope.providers,
      allowedModels: scope.models,
    }],
  } as OcxConfig;
  activateAdvisor(config);
  return config;
}

const CALLER_ADMISSION: DataPlaneAdmission = { kind: "configured", keyId: "caller", source: "bearer" };

function workerRequest(input: unknown) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "acct-scope" })}`,
      "chatgpt-account-id": "acct-scope",
      "thread-id": "thread-scope-transport",
    },
    body: JSON.stringify({ model: "worker/deepseek-v4", input, stream: true }),
  });
}

describe("advisor admission-scope transport (end-to-end)", () => {
  test("a key scoped off the advisor provider has the consult refused before the expert is called", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const expertCalls: string[] = [];
    const consults: ConsultRecord[] = [];
    const config = scopedConfig(
      { providers: ["worker"], models: ["worker/deepseek-v4"] },
      workerBodies,
      expertCalls,
    );
    loopbackInterceptor(config, consults);

    const response = await handleResponses(
      workerRequest("Fix the failing auth tests"), config, logCtx, { admission: CALLER_ADMISSION },
    );
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);

    // The consult WAS attempted and carried the captured caller scope on the capability call.
    expect(consults).toHaveLength(1);
    expect(decodeAdvisorAdmissionScope(consults[0]!.scopeHeader))
      .toEqual({ providers: ["worker"], models: ["worker/deepseek-v4"] });
    // The Advisor's own destination check failed closed on the inherited scope.
    expect(consults[0]!.status).toBe(403);
    expect(consults[0]!.errorType).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
    // Load-bearing: the expert provider mock was never invoked.
    expect(expertCalls).toHaveLength(0);
    // The worker turn itself completes; the advisor failure is surfaced as unavailable, not fatal.
    expect(workerBodies.length).toBeGreaterThanOrEqual(2);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  });

  test("a key scoped onto the advisor provider is consulted and the advice is reinjected", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const expertCalls: string[] = [];
    const consults: ConsultRecord[] = [];
    const config = scopedConfig(
      { providers: ["worker", "expert"], models: ["worker/deepseek-v4", "expert/gpt-6-astra"] },
      workerBodies,
      expertCalls,
    );
    loopbackInterceptor(config, consults);

    const response = await handleResponses(
      workerRequest("Fix the failing auth tests"), config, logCtx, { admission: CALLER_ADMISSION },
    );
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);

    expect(consults).toHaveLength(1);
    expect(decodeAdvisorAdmissionScope(consults[0]!.scopeHeader))
      .toEqual({ providers: ["worker", "expert"], models: ["worker/deepseek-v4", "expert/gpt-6-astra"] });
    expect(consults[0]!.status).toBe(200);
    expect(expertCalls).toHaveLength(1);
    const expertBody = JSON.parse(expertCalls[0]!) as { model: string };
    // The upstream wire carries the resolved bare model id; the qualified selector only
    // exists on the loopback consult input, not on the provider request body.
    expect(expertBody.model).toBe("gpt-6-astra");
    // The advice reached the worker's continuation leg.
    expect(workerBodies[1]!).toContain(ADVISOR_ADVICE);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
    expect(JSON.stringify(frames)).toContain("Following the advice");
  });

  test("a restricted host key also narrows an unrestricted caller's consult", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const expertCalls: string[] = [];
    const consults: ConsultRecord[] = [];
    const config = scopedConfig(
      { providers: ["worker", "expert"], models: ["worker/deepseek-v4", "expert/gpt-6-astra"] },
      workerBodies,
      expertCalls,
    );
    // localAdmissionToken picks the FIRST configured key for the loopback consult. Make it a
    // restricted host key that may not reach the expert provider, while the caller key —
    // apiKeys[1] — has no lists at all, so its scope resolves undefined (unrestricted).
    config.apiKeys = [
      {
        id: "host", name: "host", key: "ocx_data_" + "h".repeat(40), createdAt: "2026-01-01T00:00:00.000Z",
        allowedProviders: ["worker"], allowedModels: ["worker/deepseek-v4"],
      },
      { id: "caller", name: "caller", key: "ocx_data_" + "c".repeat(40), createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    loopbackInterceptor(config, consults);

    const response = await handleResponses(
      workerRequest("Fix the failing auth tests"), config, logCtx, { admission: CALLER_ADMISSION },
    );
    expect(response.status).toBe(200);
    const frames = await collectSse(response.body!);

    // The consult carries an explicit empty scope — defined but unrestricted — so the
    // receiver intersects it with the host key rather than replacing host limits.
    expect(consults).toHaveLength(1);
    expect(decodeAdvisorAdmissionScope(consults[0]!.scopeHeader))
      .toEqual({ providers: [], models: [] });
    expect(consults[0]!.status).toBe(403);
    expect(expertCalls).toHaveLength(0);
    expect(workerBodies.length).toBeGreaterThanOrEqual(2);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(true);
  });
});

/**
 * The scope header has authority ONLY beside the process-owned capability. An ordinary
 * caller that sends the same metadata — absent, foreign, or malformed — must see it
 * ignored, not applied: it can narrow nobody. Only a capability-authenticated caller gets
 * the malformed value refused, which keeps a corrupt sidecar loud instead of silently wide.
 */
describe("advisor admission-scope metadata without the capability (negative regression)", () => {
  function chatConfig(workerBodies: string[]): OcxConfig {
    return {
      port: 0,
      providers: {
        worker: {
          adapter: "openai-chat",
          baseUrl: "https://worker.test/v1",
          apiKey: "worker-key",
          models: ["deepseek-v4"],
          fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
            workerBodies.push(String(init?.body));
            return chatCompletion("worker answer");
          }) as typeof fetch,
        },
      },
      apiKeys: [{
        id: "caller", name: "caller", key: "ocx_data_" + "c".repeat(40),
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
    } as OcxConfig;
  }

  let chatSeq = 0;
  function sendChat(config: OcxConfig, headers: Record<string, string>) {
    chatSeq += 1;
    return handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "worker/deepseek-v4",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    }), config, logCtx, {
      requestId: "scope-neg-" + chatSeq,
      start: Date.now(),
      admission: CALLER_ADMISSION,
    });
  }

  // A scope naming only "expert" would refuse "worker" if it were applied; every case below
  // must instead reach the worker normally, proving the metadata was ignored.
  const FOREIGN_SCOPE = { providers: ["expert"], models: [] };

  test("a scope header without the capability does not narrow an ordinary caller", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const response = await sendChat(chatConfig(workerBodies), {
      [ADVISOR_ADMISSION_SCOPE_HEADER]: encodeAdvisorAdmissionScope(FOREIGN_SCOPE),
    });
    expect(response.status).toBe(200);
    expect(workerBodies).toHaveLength(1);
  });

  test("a scope header beside a foreign capability does not narrow an ordinary caller", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    // Shaped like a capability but not this process's: any caller can mint such a string.
    const response = await sendChat(chatConfig(workerBodies), {
      [ADVISOR_INTERNAL_CAPABILITY_HEADER]: "A".repeat(43),
      [ADVISOR_ADMISSION_SCOPE_HEADER]: encodeAdvisorAdmissionScope(FOREIGN_SCOPE),
    });
    expect(response.status).toBe(200);
    expect(workerBodies).toHaveLength(1);
  });

  test("a malformed scope header without the capability is ignored, not refused", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const response = await sendChat(chatConfig(workerBodies), {
      [ADVISOR_ADMISSION_SCOPE_HEADER]: "not-a-scope",
    });
    expect(response.status).toBe(200);
    expect(workerBodies).toHaveLength(1);
  });

  test("a malformed scope header beside the real capability IS refused", async () => {
    releaseSpendHome = acquireOwnedSpendHome();
    const workerBodies: string[] = [];
    const response = await sendChat(chatConfig(workerBodies), {
      [ADVISOR_INTERNAL_CAPABILITY_HEADER]: internalCallCapability(),
      [ADVISOR_ADMISSION_SCOPE_HEADER]: "not-a-scope",
    });
    expect(response.status).toBe(403);
    const body = await response.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
    expect(workerBodies).toHaveLength(0);
    // The refusal must land in the request log like every other early rejection: exactly
    // one final row at 403 — and the malformed scope value, caller data, is never copied.
    const rows = getRequestLogEntries().filter(entry => entry.requestId === `scope-neg-${chatSeq}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(403);
    expect(JSON.stringify(rows)).not.toContain("not-a-scope");
  });
});
