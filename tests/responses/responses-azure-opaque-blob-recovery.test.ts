import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterDefinitions } from "../../src/adapters/registry";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { resolvedAdapterWire } from "../../src/responses/continuation-ownership";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import {
  adapterSpeaksResponsesWire,
  attemptOpaqueBlobRecovery,
  shouldAttemptOpaqueBlobRecovery,
  type OpaqueBlobRecoveryGuard,
} from "../../src/server/responses/core-opaque-recovery";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #5583: moving a Responses conversation onto Azure OpenAI replays reasoning state the previous
 * provider minted. Azure wraps the Responses passthrough under the adapter name `azure-openai`, so
 * a recovery gate keyed on the name `openai-responses` never ran, and once it ran the stripped
 * reasoning item still carried the previous provider's `rs_*` id, which a stateful destination
 * resolves against its own store and answers "Item with id ... not found".
 *
 * Every end-to-end case runs twice, once on Azure and once on the plain Responses adapter, because
 * the fix is meant to make the two behave identically rather than to special-case Azure.
 */

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;
const FOREIGN_BLOB = "gAAAAB-previous-provider-reasoning-state";
const FOREIGN_ITEM_ID = "rs_foreign_backend";
// The body the reporter captured from Azure after the switch.
const AZURE_BLOB_REJECTION = JSON.stringify({
  error: {
    message: "The encrypted content gAAA... could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_encrypted_content",
  },
});
// What the same destination answers when only the blob was stripped and the foreign id survived.
const FOREIGN_ITEM_NOT_FOUND = JSON.stringify({
  error: {
    message: `Item with id '${FOREIGN_ITEM_ID}' not found.`,
    type: "invalid_request_error",
    param: "input",
    code: null,
  },
});
const UNRELATED_400 = JSON.stringify({
  error: { message: "Unknown parameter: 'bogus'.", type: "invalid_request_error", param: "bogus", code: "unknown_parameter" },
});
const RATE_LIMITED = JSON.stringify({
  error: { message: "Rate limit reached. Please retry later.", type: "rate_limit_error", code: "rate_limit_exceeded" },
});
const PROVIDERS = ["azure", "responses"] as const;
type ProviderName = typeof PROVIDERS[number];

let testDir = "";
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-azure-opaque-recovery-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  removeTreeWithRetry(testDir);
});

function config(): OcxConfig {
  return {
    defaultProvider: "azure",
    providers: {
      azure: {
        adapter: "azure-openai",
        baseUrl: "https://azure.example.test/openai/v1",
        authMode: "key",
        apiKey: "azure-test-key",
      },
      responses: {
        adapter: "openai-responses",
        baseUrl: "https://responses.example.test/v1",
        authMode: "key",
        apiKey: "responses-test-key",
      },
    },
  } as OcxConfig;
}

function foreignReasoningItem(): Record<string, unknown> {
  return {
    type: "reasoning",
    id: FOREIGN_ITEM_ID,
    summary: [{ type: "summary_text", text: "prior reasoning" }],
    encrypted_content: FOREIGN_BLOB,
  };
}

function userMessage(): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly OK." }] };
}

/**
 * `store` is deliberately omitted, as in the reporter's reproduction. With `store: false` every
 * item id is already removed, which is why the foreign id only surfaced on this shape.
 */
function switchedRequest(
  provider: ProviderName,
  session = `session-${provider}`,
  options: { model?: string; input?: Array<Record<string, unknown>> } = {},
): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", session_id: session },
    body: JSON.stringify({
      model: `${provider}/${options.model ?? "gpt-5.6-sol"}`,
      stream: false,
      input: options.input ?? [foreignReasoningItem(), userMessage()],
    }),
  });
}

function serializedOutboundWithForeignState(): string {
  return JSON.stringify({ model: "gpt-5.6-sol", input: [foreignReasoningItem(), userMessage()] });
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function success(id: string): Response {
  return Response.json({ id, object: "response", status: "completed", model: "gpt-5.6-sol", output: [] });
}

function carriesForeignBlob(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes(FOREIGN_BLOB);
}

function carriesForeignItemId(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes(FOREIGN_ITEM_ID);
}

/** A stateful Responses destination: foreign blobs are refused, and so is a foreign stored id. */
function statefulDestination(outbound: Array<Record<string, unknown>>): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    outbound.push(body);
    if (carriesForeignBlob(body)) return jsonResponse(400, AZURE_BLOB_REJECTION);
    if (carriesForeignItemId(body)) return jsonResponse(400, FOREIGN_ITEM_NOT_FOUND);
    return success(`resp-${outbound.length}`);
  }) as typeof fetch;
}

describe("the recovery gate follows the adapter's declared Responses contract", () => {
  const base = {
    status: 400,
    outboundBody: serializedOutboundWithForeignState(),
    errorBody: AZURE_BLOB_REJECTION,
    alreadyAttempted: false,
  };

  test("every registered adapter that resolves to the Responses wire is admitted, and no other", () => {
    const admitted: string[] = [];
    for (const [adapterId] of adapterDefinitions()) {
      const speaksResponses = resolvedAdapterWire(adapterId) === "openai-responses";
      expect({ adapterId, admitted: adapterSpeaksResponsesWire(adapterId) })
        .toEqual({ adapterId, admitted: speaksResponses });
      expect({ adapterId, recovers: shouldAttemptOpaqueBlobRecovery({ ...base, adapterName: adapterId }) })
        .toEqual({ adapterId, recovers: speaksResponses });
      if (speaksResponses) admitted.push(adapterId);
    }
    // The issue's adapter and its alias are covered through contractParent, not by name.
    expect(admitted).toContain("azure-openai");
    expect(admitted).toContain("azure");
    expect(adapterSpeaksResponsesWire("not-a-registered-adapter")).toBe(false);
  });

  test("azure-openai does not recover an ordinary 400, a 429, or a 5xx", () => {
    const azure = { ...base, adapterName: "azure-openai" };
    expect(shouldAttemptOpaqueBlobRecovery(azure)).toBe(true);
    expect(shouldAttemptOpaqueBlobRecovery({ ...azure, errorBody: UNRELATED_400 })).toBe(false);
    expect(shouldAttemptOpaqueBlobRecovery({ ...azure, status: 429, errorBody: RATE_LIMITED })).toBe(false);
    for (const status of [500, 502, 503]) {
      expect({ status, recovers: shouldAttemptOpaqueBlobRecovery({ ...azure, status }) })
        .toEqual({ status, recovers: false });
    }
    // The destination's answer to a surviving foreign id is not itself an opaque-state identity.
    expect(shouldAttemptOpaqueBlobRecovery({ ...azure, errorBody: FOREIGN_ITEM_NOT_FOUND })).toBe(false);
  });

  test("the recovery path never rebuilds for those statuses, and the guard is single-shot", async () => {
    const signal = new AbortController().signal;
    const guard: OpaqueBlobRecoveryGuard = { attempted: false };
    let rebuilds = 0;
    const rebuild = async () => {
      rebuilds += 1;
      return success("resp-rebuilt");
    };
    const attempt = (response: Response) => attemptOpaqueBlobRecovery({
      response,
      outboundBody: serializedOutboundWithForeignState(),
      adapterName: "azure-openai",
      parsed: { _rawBody: { input: [foreignReasoningItem(), userMessage()] } } as unknown as OcxParsedRequest,
      guard,
      signal,
    }, rebuild);

    for (const response of [
      jsonResponse(400, UNRELATED_400),
      jsonResponse(429, RATE_LIMITED),
      jsonResponse(500, AZURE_BLOB_REJECTION),
      jsonResponse(503, AZURE_BLOB_REJECTION),
    ]) {
      expect((await attempt(response)).kind).toBe("skipped");
    }
    expect(rebuilds).toBe(0);
    expect(guard.attempted).toBe(false);

    expect((await attempt(jsonResponse(400, AZURE_BLOB_REJECTION))).kind).toBe("recovered");
    expect(rebuilds).toBe(1);
    // The same guard object serves every recovery site of one request; a later rejection on it,
    // including a streamed one, gets no second rebuild.
    expect((await attempt(jsonResponse(400, AZURE_BLOB_REJECTION))).kind).toBe("skipped");
    expect(rebuilds).toBe(1);
  });
});

describe("switching a conversation onto a Responses destination through /v1/responses", () => {
  for (const provider of PROVIDERS) {
    test(`${provider}: one recovered send carries no foreign blob and no foreign reasoning id`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      statefulDestination(outbound);
      const logCtx: RequestLogContext = { model: "", provider: "" };

      const response = await handleResponses(switchedRequest(provider), config(), logCtx);
      expect(response.status).toBe(200);
      await response.text();

      expect(outbound).toHaveLength(2);
      const [rejected, recovered] = outbound as [Record<string, unknown>, Record<string, unknown>];
      expect(carriesForeignBlob(rejected)).toBe(true);
      expect(carriesForeignItemId(rejected)).toBe(true);
      expect(recovered.input).toEqual([
        { type: "reasoning", summary: [{ type: "summary_text", text: "prior reasoning" }] },
        userMessage(),
      ]);
      expect(logCtx.activeAttempt?.sendCount).toBe(2);
      expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["opaque-blob-rejection"]);
    });

    test(`${provider}: later turns strip the blob and the id before the first send`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      statefulDestination(outbound);
      const turns: RequestLogContext[] = [];

      for (let turn = 0; turn < 3; turn++) {
        const logCtx: RequestLogContext = { model: "", provider: "" };
        turns.push(logCtx);
        const response = await handleResponses(switchedRequest(provider, `memo-${provider}`), config(), logCtx);
        expect({ turn, status: response.status }).toEqual({ turn, status: 200 });
        await response.text();
      }

      expect(outbound).toHaveLength(4);
      expect(outbound.map(carriesForeignBlob)).toEqual([true, false, false, false]);
      expect(outbound.map(carriesForeignItemId)).toEqual([true, false, false, false]);
      expect(turns.map(turn => turn.activeAttempt?.sendCount)).toEqual([2, 1, 1]);
    });

    test(`${provider}: a second rejection surfaces after exactly one recovery send`, async () => {
      let sends = 0;
      globalThis.fetch = (async () => {
        sends += 1;
        return jsonResponse(400, AZURE_BLOB_REJECTION);
      }) as typeof fetch;

      const response = await handleResponses(switchedRequest(provider), config(), { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("invalid_encrypted_content");
      expect(sends).toBe(2);
    });

    test(`${provider}: the recovery send is drawn from the request's budget, not a fresh one`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      statefulDestination(outbound);
      // One send for the whole logical request: the rejected first send spends it.
      const budget = createRequestExecutionBudget({
        maxTotalModelSends: 1,
        baseSendAllowance: 1,
        finalRecoveryAllowance: 0,
        maxAlternateTargetSends: 0,
        maxTargetTransitions: 0,
      }, `azure-opaque-one-send-${provider}`);

      const response = await handleResponses(
        switchedRequest(provider),
        config(),
        { model: "", provider: "" },
        { sendBudget: budget },
      );
      const body = await response.text();

      expect(outbound).toHaveLength(1);
      expect(carriesForeignBlob(outbound[0]!)).toBe(true);
      expect(response.status).not.toBe(200);
      expect(body).toContain("request_send_budget_exhausted");
      expect(budget.used).toBe(1);
    });

    test(`${provider}: a proven switch from another destination drops the blob and the id before the first send`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      statefulDestination(outbound);
      const previous: ProviderName = provider === "azure" ? "responses" : "azure";
      const session = `proven-switch-to-${provider}`;

      // The conversation is first served by the other provider, which records its serving route.
      const seeded = await handleResponses(
        switchedRequest(previous, session, { input: [userMessage()] }),
        config(),
        { model: "", provider: "" },
      );
      expect(seeded.status).toBe(200);
      await seeded.text();

      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponses(switchedRequest(provider, session), config(), logCtx);
      expect(response.status).toBe(200);
      await response.text();

      expect(outbound).toHaveLength(2);
      expect(carriesForeignBlob(outbound[1]!)).toBe(false);
      expect(carriesForeignItemId(outbound[1]!)).toBe(false);
      expect(logCtx.activeAttempt?.sendCount).toBe(1);
    });

    test(`${provider}: a proven switch from another destination also drops the id of a blobless reasoning item`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      statefulDestination(outbound);
      const previous: ProviderName = provider === "azure" ? "responses" : "azure";
      const session = `id-only-switch-to-${provider}`;
      const idOnlyReasoning = {
        type: "reasoning",
        id: FOREIGN_ITEM_ID,
        summary: [{ type: "summary_text", text: "prior reasoning" }],
      };

      const seeded = await handleResponses(
        switchedRequest(previous, session, { input: [userMessage()] }),
        config(),
        { model: "", provider: "" },
      );
      expect(seeded.status).toBe(200);
      await seeded.text();

      const response = await handleResponses(
        switchedRequest(provider, session, { input: [idOnlyReasoning, userMessage()] }),
        config(),
        { model: "", provider: "" },
      );
      expect(response.status).toBe(200);
      await response.text();

      expect(outbound).toHaveLength(2);
      expect(outbound[1]!.input).toEqual([
        { type: "reasoning", summary: [{ type: "summary_text", text: "prior reasoning" }] },
        userMessage(),
      ]);
    });

    test(`${provider}: a model change on the same destination and credential keeps the item id`, async () => {
      const outbound: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        outbound.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return success(`resp-${outbound.length}`);
      }) as typeof fetch;
      const session = `same-store-${provider}`;

      const seeded = await handleResponses(
        switchedRequest(provider, session, { model: "gpt-5.5", input: [userMessage()] }),
        config(),
        { model: "", provider: "" },
      );
      expect(seeded.status).toBe(200);
      await seeded.text();
      const response = await handleResponses(switchedRequest(provider, session), config(), { model: "", provider: "" });
      expect(response.status).toBe(200);
      await response.text();

      // The model changed, so the blob is no longer trusted, but the store that holds the item
      // is the same one and can still resolve its id.
      expect(outbound).toHaveLength(2);
      expect(carriesForeignBlob(outbound[1]!)).toBe(false);
      expect(carriesForeignItemId(outbound[1]!)).toBe(true);
    });
  }
});
