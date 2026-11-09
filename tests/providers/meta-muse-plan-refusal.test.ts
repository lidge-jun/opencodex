/**
 * Meta refuses a Muse Code subscription key outside its own client (#8352).
 *
 * The refusal is a plan/entitlement restriction on a VALID key, not a rejected or expired
 * credential: no re-login lifts it, and the only remedy is a pay-as-you-go Meta API key on the
 * `meta-model` provider. Reporting it as `permission_denied` / `credential-rejected` sent the
 * operator to re-authenticate a credential working exactly as Meta sold it, so the classifier,
 * the request-log code, the diagnostics and the client body all have to agree on the
 * subscription class and on one actionable sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyError } from "../../src/lib/errors";
import { requestLogErrorCode } from "../../src/server/request-log";
import { errorDetailFor } from "../../src/usage/error-detail";
import { formatPassthroughUpstreamError } from "../../src/server/responses/passthrough-error";
import { formatErrorResponse } from "../../src/bridge";
import { formatAdapterUpstreamFailure } from "../../src/server/responses/adapter-failure-message";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { deliverPassthroughResponse } from "../../src/server/responses/passthrough-delivery";
import type { ConsumedComboFailure } from "../../src/server/responses/core-options";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { deriveRequestFailureAttribution } from "../../src/lib/request-failure-attribution";
import { resendPermission } from "../../src/lib/request-failure-model";
import { classifyPermanentAccountRefusal } from "../../src/oauth/account-auto-pause-policy";
import { PROVIDER_REGISTRY_CORE } from "../../src/providers/registry/entries-core";
import type { RequestFailureCause } from "../../src/usage/telemetry-contract";
import {
  isMetaMusePlanFailure,
  isMetaMusePlanRefusal,
  META_MUSE_PLAN_REFUSAL_MESSAGE,
  stampMetaMusePlanRefusal,
} from "../../src/providers/meta-muse-plan-refusal";
import { repoPath } from "../helpers/repo-root";

const REFUSAL_SENTENCE = "This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests from the Muse Code client only. Use it in Muse Code, or use a pay-as-you-go API key for other clients.";

/** The OpenAI-compatible envelope Meta serves for this refusal. */
const REFUSAL_BODY = JSON.stringify({
  error: { message: REFUSAL_SENTENCE, type: "permission_error", code: "permission_denied" },
});

describe("meta-muse plan refusal: integration paths", () => {
  test("the adapter response composer answers with the proxy sentence and keeps the plan cause", async () => {
    const logCtx: { causeHint?: RequestFailureCause } = {};
    const { normalized, message } = formatAdapterUpstreamFailure({
      status: 403,
      errorText: REFUSAL_BODY,
      route: { providerName: "meta-muse", provider: { baseUrl: "https://api.meta.ai/v1", adapter: "openai-responses", authMode: "oauth" } },
      upstreamRetryAfter: null,
      denialMessage: fallback => fallback,
      logCtx,
    });
    expect(normalized.code).toBe("permission_denied");
    expect(message).toBe(META_MUSE_PLAN_REFUSAL_MESSAGE);
    expect(logCtx.causeHint).toBe("quota-exhausted");
  });

  test("the adapter composer leaves an unrelated 403 on the ordinary path", () => {
    const logCtx: { causeHint?: RequestFailureCause } = {};
    const other = JSON.stringify({ error: { message: "Forbidden", type: "permission_error", code: "permission_denied" } });
    const { message } = formatAdapterUpstreamFailure({
      status: 403,
      errorText: other,
      route: { providerName: "meta-muse", provider: { baseUrl: "https://api.meta.ai/v1", adapter: "openai-responses", authMode: "oauth" } },
      upstreamRetryAfter: null,
      denialMessage: fallback => fallback,
      logCtx,
    });
    expect(message).toContain("Forbidden");
    expect(logCtx.causeHint).toBeUndefined();
  });

  test("a combo child records the plan cause from the same body", async () => {
    const logCtx: { causeHint?: RequestFailureCause } = {};
    const failure = await consumeComboFailure(
      new Response(REFUSAL_BODY, { status: 403, headers: { "Content-Type": "application/json" } }),
      undefined,
      Date.now(),
      logCtx,
    );
    expect(logCtx.causeHint).toBe("quota-exhausted");
    const error = await bodyOf(failure.response);
    expect(error.code).toBe("subscription_required");
    // A plan restriction cannot be retried successfully, so no waiting hint is invented.
    expect(failure.response.headers.get("retry-after")).toBeNull();
  });

  test("a passthrough combo leg stamps the plan cause on its own row", async () => {
    const logCtx: { model: string; provider: string; causeHint?: RequestFailureCause; failureDetail?: unknown } = {
      model: "",
      provider: "",
    };
    let consumed: ConsumedComboFailure | undefined;
    const request = new Request("http://127.0.0.1/v1/responses", { method: "POST" });
    const response = await deliverPassthroughResponse(
      { req: request, config: { providers: {} }, logCtx,
        options: { admission: { kind: "loopback", source: "loopback" }, inboundWire: "responses",
          comboAttempt: true, onConsumedComboFailure: (value: ConsumedComboFailure) => { consumed = value; } },
      } as unknown as Parameters<typeof deliverPassthroughResponse>[0],
      { authCtx: { kind: "none" } } as Parameters<typeof deliverPassthroughResponse>[1],
      { parsed: { stream: true, modelId: "m1", _rawBody: {} }, clientRequestedStream: false,
        translatorBudget: createTestTranslatorBudget(), route: {
          provider: { adapter: "openai-responses", authMode: "key", baseUrl: "https://api.meta.example/v1" },
          providerName: "meta-muse", modelId: "m1", staticPolicy: { model: {} },
        } } as unknown as Parameters<typeof deliverPassthroughResponse>[2],
      { requestBindings: new Map() } as Parameters<typeof deliverPassthroughResponse>[3],
      {} as Parameters<typeof deliverPassthroughResponse>[4],
      { plaintextV2AgentMessageToolNames: new Set(), plaintextV2AgentMessageAliasedToolNames: new Set(),
        routedMuseToolNameAliases: new Map(), routedNamespaceToolAliases: new Map(),
        commitReasoningReplayServingRoute() {}, recordTerminalOutcomes: false,
      } as unknown as Parameters<typeof deliverPassthroughResponse>[5],
      { upstreamResponse: new Response(REFUSAL_BODY, { status: 403, headers: { "content-type": "application/json" } }),
        upstream: new AbortController(), request, connectMs: 0, imageGenCallAliases: new Map(),
        selfNamedNamespaceScrubAuthorization: new Set(), authorizedBareNamespaceToolAliases: new Map(),
        routedCustomToolNames: new Set(), routedCustomToolRepairNames: new Set(), declaredWireToolNames: new Set(),
        routedToolSearchNames: new Set(), functionRepairSchemas: new Map(), declaredNamelessClientCallTypes: new Set(),
        providerExecutedCallTypes: new Set(), declaredBareWireToolNames: new Set(),
        recoverableBareCustomWireToolNames: new Set(), undeclaredToolGuardActive: true,
        rememberPassthroughResponse: false, rememberPassthroughResponseChecked() {}, noteInspectedPayload() {},
        normalizeFunctionCompletionJson: (value: string) => value, outboundRequestBody: "{}",
      } as unknown as Parameters<typeof deliverPassthroughResponse>[6],
    );
    expect(consumed?.response).toBe(response);
    expect(logCtx.causeHint).toBe("quota-exhausted");
    // Only the cause crosses over: this path has never recorded a validation detail on the row.
    expect(logCtx.failureDetail).toBeUndefined();
    expect((await bodyOf(response)).code).toBe("subscription_required");
  });
});


async function bodyOf(response: Response): Promise<{ message?: string; code?: string | null; type?: string }> {
  const parsed = await response.json() as { error?: { message?: string; code?: string | null; type?: string } };
  return parsed.error ?? {};
}

describe("meta-muse plan refusal: classification", () => {
  test("the shared classifier names the plan restriction, not a rejected credential", () => {
    const classified = classifyError(403, "upstream_error", REFUSAL_BODY);
    expect(classified.code).toBe("subscription_required");
    expect(classified.type).toBe("permission_error");
  });

  test("a 401 stays authoritative even when the body carries this sentence", () => {
    expect(classifyError(401, "upstream_error", REFUSAL_BODY).code).toBe("invalid_api_key");
  });

  test("the request-log code is the subscription class, not permission_denied", () => {
    expect(requestLogErrorCode(403, REFUSAL_BODY)).toBe("subscription_required");
    expect(requestLogErrorCode(403, `Provider error 403: ${REFUSAL_BODY}`)).toBe("subscription_required");
  });

  test("the projected diagnostic row keeps that code", () => {
    const detail = errorDetailFor({
      status: 403,
      errorCode: requestLogErrorCode(403, REFUSAL_BODY),
      upstreamError: REFUSAL_BODY,
      upstreamErrorCode: "permission_denied",
      upstreamErrorType: "permission_error",
    });
    expect(detail.errorCode).toBe("subscription_required");
  });

  test("the row is not an account refusal that pauses or demands a re-login", () => {
    // The auto-pause roster is the one path that labels an account `needs-reauth`; this
    // refusal must not reach it, because no login can lift a plan restriction.
    expect(classifyPermanentAccountRefusal(403, {
      error: { message: REFUSAL_SENTENCE, type: "permission_error", code: "permission_denied" },
    })).toBeUndefined();
  });

  test("the refusal stamps the plan cause, whose resend verdict is refused-futile", () => {
    const logCtx: { causeHint?: RequestFailureCause } = {};
    expect(stampMetaMusePlanRefusal(logCtx, 403, REFUSAL_BODY)).toContain("META_MODEL_API_KEY");
    expect(logCtx.causeHint).toBe("quota-exhausted");
    const attribution = deriveRequestFailureAttribution({ status: 403, causeHint: logCtx.causeHint, outputObserved: false });
    expect(attribution?.cause).toBe("quota-exhausted");
    expect(resendPermission(attribution!.stage, attribution!.cause!)).toBe("refused-futile");

    const other: { causeHint?: RequestFailureCause } = {};
    expect(stampMetaMusePlanRefusal(other, 403, JSON.stringify({ error: { message: "Forbidden" } }))).toBeUndefined();
    expect(other.causeHint).toBeUndefined();
  });
});

describe("meta-muse plan refusal: client message", () => {
  test("the passthrough body names the restriction and the supported alternative", async () => {
    const response = formatPassthroughUpstreamError(403, REFUSAL_BODY);
    const error = await bodyOf(response);
    expect(response.status).toBe(403);
    expect(error.code).toBe("subscription_required");
    expect(error.message).toContain("Muse Code client");
    expect(error.message).toContain("pay-as-you-go");
    expect(error.message).toContain("META_MODEL_API_KEY");
    expect(error.message).not.toContain("re-login to");
  });

  test("the adapter failure body carries the same sentence and code", async () => {
    const response = formatErrorResponse(403, "upstream_error", `Provider error 403: ${REFUSAL_BODY}`);
    const error = await bodyOf(response);
    expect(error.code).toBe("subscription_required");
    expect(error.message).toBe(META_MUSE_PLAN_REFUSAL_MESSAGE);
  });

  test("the sentence re-classifies to the same class on a later formatting pass", () => {
    // The message travels through the Chat and Anthropic formatters, which classify their own
    // proxy-authored copy again; drifting to permission_denied there would undo the fix.
    expect(classifyError(403, "permission_error", META_MUSE_PLAN_REFUSAL_MESSAGE).code).toBe("subscription_required");
    // Framed by a later HTTP error pass, the proxy's own copy keeps the class too.
    expect(classifyError(403, "upstream_error", `Provider error 403: ${META_MUSE_PLAN_REFUSAL_MESSAGE}`).code)
      .toBe("subscription_required");
  });

  test("the rewritten passthrough body keeps the relayed request id and status text", async () => {
    const response = formatPassthroughUpstreamError(403, REFUSAL_BODY, {
      statusText: "Forbidden",
      headers: new Headers({ "x-request-id": "req_123", "content-type": "application/json", "content-length": "999", "retry-after": "5" }),
    });
    expect(response.status).toBe(403);
    expect(response.statusText).toBe("Forbidden");
    expect(response.headers.get("x-request-id")).toBe("req_123");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { error?: { message?: string; code?: string } };
    expect(body.error?.code).toBe("subscription_required");
    expect(body.error?.message).toBe(META_MUSE_PLAN_REFUSAL_MESSAGE);
    // A later pass that re-parses this envelope keeps the subscription class.
    expect(classifyError(403, "upstream_error", JSON.stringify(body)).code).toBe("subscription_required");
  });

  test("an unrelated 403 keeps its own body", async () => {
    const other = JSON.stringify({ error: { message: "You do not have access to this model.", type: "permission_error", code: "permission_denied" } });
    const response = formatPassthroughUpstreamError(403, other);
    expect(await response.text()).toBe(other);
  });
});

describe("meta-muse plan refusal: bounded match", () => {
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    error: { message: REFUSAL_SENTENCE, type: "permission_error", code: "permission_denied", ...overrides },
  });

  test("the exact envelope on a 403 is the refusal", () => {
    expect(isMetaMusePlanRefusal(403, envelope())).toBe(true);
    expect(isMetaMusePlanRefusal(403, envelope({ code: undefined }))).toBe(true);
    expect(isMetaMusePlanRefusal(403, envelope({ type: "invalid_request_error" }))).toBe(true);
  });

  test("another status, envelope or sentence is not", () => {
    for (const status of [200, 401, 402, 429, 500]) expect(isMetaMusePlanRefusal(status, envelope())).toBe(false);
    expect(isMetaMusePlanRefusal(403, { error: { message: REFUSAL_SENTENCE.slice(0, 40), type: "permission_error" } })).toBe(false);
    expect(isMetaMusePlanRefusal(403, { error: { message: `${REFUSAL_SENTENCE} Contact support.`, type: "permission_error" } })).toBe(false);
    expect(isMetaMusePlanRefusal(403, { error: { message: REFUSAL_SENTENCE, type: "authentication_error" } })).toBe(false);
    expect(isMetaMusePlanRefusal(403, { error: { message: REFUSAL_SENTENCE, code: "invalid_api_key" } })).toBe(false);
    expect(isMetaMusePlanRefusal(403, { error: { message: "x".repeat(9 * 1024), type: "permission_error" } })).toBe(false);
    expect(isMetaMusePlanRefusal(403, REFUSAL_SENTENCE)).toBe(false);
    expect(isMetaMusePlanRefusal(403, null)).toBe(false);
  });

  test("the framed and bare forms both match", () => {
    expect(isMetaMusePlanFailure(403, `Provider error 403: ${REFUSAL_BODY}`)).toBe(true);
    expect(isMetaMusePlanFailure(403, REFUSAL_SENTENCE)).toBe(true);
    expect(isMetaMusePlanFailure(401, REFUSAL_BODY)).toBe(false);
    expect(isMetaMusePlanFailure(403, JSON.stringify({ error: { message: "Forbidden", type: "permission_error" } }))).toBe(false);
  });
});

describe("meta-muse plan refusal: documentation and registry", () => {
  test("the registry note states the restriction and the supported key", () => {
    const entry = PROVIDER_REGISTRY_CORE.find(row => row.id === "meta-muse");
    expect(entry?.note).toContain("pay-as-you-go");
    expect(entry?.note).toContain("plan restriction");
  });

  test("the English provider guide and adapter reference say it before a user hits it", () => {
    const guide = readFileSync(repoPath("docs-site/src/content/docs/guides/providers.md"), "utf8");
    const adapters = readFileSync(repoPath("docs-site/src/content/docs/reference/adapters.md"), "utf8");
    expect(guide).toContain("This API key is billed to a Muse Code subscription");
    expect(guide).toContain("plan restriction");
    expect(adapters).toContain("plan restriction");
    expect(adapters).toContain("meta-model");
  });
});
