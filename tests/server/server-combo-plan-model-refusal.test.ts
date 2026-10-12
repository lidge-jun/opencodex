import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { handleResponses } from "../../src/server/responses";
import { captureCallerDirectAuth } from "../../src/providers/caller-authorization";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/account-id";
import { clearCodexUpstreamHealth, getCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { clearResponseStateForTests } from "../../src/responses/state";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { responsesSuccess } from "../helpers/combo-failover-upstream";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousCodex = process.env.CODEX_HOME;
let home = "";
let releaseSpendHome: () => void;
const firstModel = "gpt-5.5";
const secondModel = "gpt-5.4";
const refusal = `The '${firstModel}' model is not supported when using Codex with a ChatGPT account.`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-plan-refusal-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearResponseStateForTests();
});

afterEach(() => {
  releaseSpendHome();
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  clearResponseStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodex;
  removeTreeWithRetry(home);
});

async function run(body: unknown, streamEvent?: Record<string, unknown>, committed = false): Promise<{ response: Response; sends: string[] }> {
  const providerId = streamEvent ? "fixture" : "openai";
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: providerId,
    providers: { [providerId]: streamEvent ? {
      adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key",
    } : {
      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward", codexAccountMode: "direct",
    } },
    codexAccounts: [],
    combos: { plans: { strategy: "failover", targets: [
      { provider: providerId, model: firstModel }, { provider: providerId, model: secondModel },
    ] } },
  };
  const caller = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture-caller", chatgpt_user_id: "fixture-user" } });
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${caller}` });
  const callerDirectAuth = captureCallerDirectAuth(headers, config);
  expect(callerDirectAuth).not.toBeNull();
  const sends: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== (streamEvent ? "fixture.test" : "chatgpt.com") || !url.pathname.endsWith("/responses")) {
      throw new Error(`Unexpected mocked endpoint: ${url.origin}${url.pathname}`);
    }
    const payload = await new Response(init?.body).json() as { model: string };
    sends.push(payload.model);
    expect(new Headers(init?.headers).get("authorization")).toBe(streamEvent ? "Bearer fixture-key" : `Bearer ${caller}`);
    if (payload.model === firstModel) {
      if (!streamEvent) return typeof body === "string" ? new Response(body, { status: 400 })
        : Response.json(body, { status: 400 });
      const events = [
        ...(committed ? [{ type: "response.output_text.delta", delta: "already visible" }] : []),
        streamEvent,
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    }
    expect(payload.model).toBe(secondModel);
    if (streamEvent) return new Response(`data: ${JSON.stringify({ type: "response.completed",
      response: responsesSuccess("fallback succeeded", secondModel) })}\n\n`,
      { headers: { "content-type": "text/event-stream" } });
    return Response.json(responsesSuccess("fallback succeeded", secondModel));
  }) as typeof fetch;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers, body: JSON.stringify({ model: "combo/plans", input: "hello", stream: !!streamEvent }),
  }), config, { model: "", provider: "" } as RequestLogContext, { callerDirectAuth });
  return { response, sends };
}

test.each([0, 800])("a plan refusal reaches another model on the same provider (padding=%s)", async padding => {
  const before = getCodexUpstreamHealth(MAIN_CODEX_ACCOUNT_ID);
  const { response, sends } = await run({ detail: refusal, padding: "x".repeat(padding) });
  expect(response.status).toBe(200);
  await response.text();
  expect(sends).toEqual([firstModel, secondModel]);
  expect(getCodexUpstreamHealth(MAIN_CODEX_ACCOUNT_ID)).toEqual(before);
  expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
});

test.each([0, 800])("a mixed plan envelope stops despite unsupported_model (padding=%s)", async padding => {
  const { response, sends } = await run({ detail: refusal,
    error: { code: "unsupported_model", type: "invalid_request_error", message: "bad input" }, padding: "x".repeat(padding) });
  expect(response.status).toBe(400);
  await response.text();
  expect(sends).toEqual([firstModel]);
  expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
});


for (const shape of ["bare", "nested"] as const) {
  for (const mixed of [false, true]) {
    test(`padded ${shape} stream ${mixed ? "mixed envelope stops" : "plan refusal hops"}`, async () => {
      const error = { type: "invalid_request_error", code: mixed ? "unsupported_model" : "invalid_request_error",
        message: mixed ? "bad input" : refusal };
      const envelope = { error, ...(mixed ? { detail: refusal } : {}), padding: "x".repeat(800) };
      const event = shape === "bare" ? { type: "error", status: 400, ...envelope }
        : { type: "response.failed", response: { status: "failed", ...envelope } };
      const { response, sends } = await run(undefined, event);
      const text = await response.text();
      expect(sends).toEqual(mixed ? [firstModel] : [firstModel, secondModel]);
      expect(text.includes("fallback succeeded")).toBe(!mixed);
      expect(text).not.toContain("codexModelRefusal");
      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    });
  }
  test(`${shape} plan failure after committed output never replays`, async () => {
    const error = { type: "invalid_request_error", message: refusal };
    const event = shape === "bare" ? { type: "error", status: 400, error }
      : { type: "response.failed", response: { status: "failed", error } };
    const { response, sends } = await run(undefined, event, true);
    expect(await response.text()).toContain("already visible");
    expect(sends).toEqual([firstModel]);
  });
}


test("a bare error cannot borrow a refusal from an unrelated nested response", async () => {
  const { response, sends } = await run(undefined, {
    type: "error", status: 400, code: "invalid_request_error", message: "bad input",
    response: { error: { type: "invalid_request_error", message: refusal } },
  });
  expect(await response.text()).not.toContain("fallback succeeded");
  expect(sends).toEqual([firstModel]);
});

test("outer refusal detail cannot be discarded for a nested unsupported-model error", async () => {
  const { response, sends } = await run(undefined, {
    type: "response.failed", detail: refusal, padding: "x".repeat(800),
    response: { status: "failed", error: {
      type: "invalid_request_error", code: "unsupported_model", message: "bad input",
    } },
  });
  expect(await response.text()).not.toContain("fallback succeeded");
  expect(sends).toEqual([firstModel]);
});

test.each([false, true])("an unrelated outer quote does not determine nested refusal (refusal=%s)", async modelRefusal => {
  const { response, sends } = await run(undefined, {
    type: "response.failed", note: refusal,
    response: { status: "failed", error: {
      type: "invalid_request_error", code: "invalid_request_error", message: modelRefusal ? refusal : "bad input",
    } },
  });
  const text = await response.text();
  expect(sends).toEqual(modelRefusal ? [firstModel, secondModel] : [firstModel]);
  expect(text.includes("fallback succeeded")).toBe(modelRefusal);
});

for (const detail of ["bad input", null]) {
  test(`outer detail presence blocks nested refusal even for ${detail}`, async () => {
    const { response, sends } = await run(undefined, {
      type: "response.failed", detail,
      response: { status: "failed", error: { type: "invalid_request_error", message: refusal } },
    });
    expect(await response.text()).not.toContain("fallback succeeded");
    expect(sends).toEqual([firstModel]);
  });
}

test("outer error presence blocks nested detail despite a model code", async () => {
  const { response, sends } = await run(undefined, {
    type: "error", status: 400, error: { type: "invalid_request_error", code: "unsupported_model", message: "bad input" },
    response: { detail: refusal },
  });
  expect(await response.text()).not.toContain("fallback succeeded");
  expect(sends).toEqual([firstModel]);
});

for (const carrier of ["detail", "error"] as const) {
  test.each([0, 800])(`nested-only HTTP ${carrier} refusal hops (padding=%s)`, async padding => {
    const nested = carrier === "detail" ? { detail: refusal } : { error: { message: refusal } };
    const { response, sends } = await run({ response: nested, padding: "x".repeat(padding) });
    expect(response.status).toBe(200);
    await response.text();
    expect(sends).toEqual([firstModel, secondModel]);
  });
}

test("HTTP root carrier stays authoritative over a same-kind nested refusal", async () => {
  for (const error of [null, { message: "bad input" }]) {
    const { response, sends } = await run({ error, response: { error: { message: refusal } } });
    expect(response.status).toBe(400);
    await response.text();
    expect(sends).toEqual([firstModel]);
  }
});

test("HTTP nested carrier does not recursively search quotes or accept non-record responses", async () => {
  for (const nested of [null, [], [{ detail: refusal }], { quoted: { detail: refusal } },
    { response: { error: { message: refusal } } }]) {
    const { response, sends } = await run({ response: nested });
    expect(response.status).toBe(400);
    await response.text();
    expect(sends).toEqual([firstModel]);
  }
});

for (const detailLevel of ["root", "response"] as const) {
  for (const errorLevel of ["root", "response"] as const) {
    test(`HTTP mixed ${detailLevel} detail / ${errorLevel} error stops before model-code hop`, async () => {
      const root: Record<string, unknown> = { padding: "x".repeat(800) };
      const nested: Record<string, unknown> = {};
      (detailLevel === "root" ? root : nested).detail = null;
      (errorLevel === "root" ? root : nested).error = { message: refusal, code: "unsupported_model" };
      root.response = nested;
      const { response, sends } = await run(root);
      expect(response.status).toBe(400);
      await response.text();
      expect(sends).toEqual([firstModel]);
    });
  }
}

test.each(["detail", "error"] as const)("bare SSE message cannot borrow a nested HTTP %s carrier", async carrier => {
  const nested = carrier === "detail" ? { detail: refusal } : { error: { message: refusal } };
  const { response, sends } = await run(undefined, {
    type: "error", status: 400, code: "invalid_request_error", message: JSON.stringify({ response: nested }),
  });
  expect(await response.text()).not.toContain("fallback succeeded");
  expect(sends).toEqual([firstModel]);
});

for (const prefix of ["", "Provider error 400: "]) {
  test.each(["upstream_no_response", "origin-rejected", "cyber_policy"])(
    `HTTP ${prefix || "bare JSON"} nested hard stop %s never replays`, async code => {
      const { response, sends } = await run(prefix + JSON.stringify({ padding: "x".repeat(800), response: { error: { code, message: refusal } } }));
      expect(response.status).toBe(400);
      await response.text();
      expect(sends).toEqual([firstModel]);
    },
  );
  test(`HTTP ${prefix || "bare JSON"} root hard stop cannot be hidden by nested model code`, async () => {
    const { response, sends } = await run(prefix + JSON.stringify({ padding: "x".repeat(800), code: " ORIGIN-REJECTED ",
      response: { error: { code: "unsupported_model", message: refusal } } }));
    expect(response.status).toBe(400);
    await response.text();
    expect(sends).toEqual([firstModel]);
  });
}

test.each(["Provider error 400: ", "Provider error 401: ", "Provider error 400: Provider error 400: "])(
  "HTTP refusal permits only a single matching prefix (%s)", async prefix => {
    const { response, sends } = await run(prefix + JSON.stringify({ response: { error: { message: refusal } } }));
    const valid = prefix === "Provider error 400: ";
    expect(response.status).toBe(valid ? 200 : 400);
    await response.text();
    expect(sends).toEqual(valid ? [firstModel, secondModel] : [firstModel]);
  },
);

test("SSE structured model code does not borrow a hard stop from quoted HTTP JSON", async () => {
  const { response, sends } = await run(undefined, {
    type: "error", status: 400, error: { code: "unsupported_model",
      message: JSON.stringify({ response: { error: { code: "upstream_no_response", message: refusal } } }) },
  });
  expect(await response.text()).toContain("fallback succeeded");
  expect(sends).toEqual([firstModel, secondModel]);
});

for (const nested of [false, true]) {
  for (const type of ["cyber_policy", "upstream_no_response", "upstream_closed_before_response", "upstream_reset_replay_refused"]) {
    test.each(["fixture failure", refusal])(`HTTP code overrides diagnostic ${type} (nested=${nested}, message=%s)`, async message => {
      const record = { error: { code: "unsupported_model", type, message } };
      const { response, sends } = await run(nested ? { response: record } : record);
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toEqual([firstModel, secondModel]);
    });
  }
}

test("diagnostic type cannot manufacture consumed/serialized codes, retry headers or replay markers", async () => {
  for (const nested of [false, true]) {
    for (const code of ["unsupported_model", "unknown_code", "", "  ", undefined, null, 17, {}]) {
      for (const type of ["cyber_policy", "upstream_no_response", "upstream_reset_replay_refused", "origin_rejected"]) {
        const record = { error: { code, type, message: "fixture failure" } };
        const consumed = await consumeComboFailure(Response.json(nested ? { response: record } : record, { status: 400 }));
        expect(consumed.upstreamCode).toBe(typeof code === "string" && code.trim() ? code.trim() : undefined);
        expect(consumed.upstreamType).toBe(type);
        expect(consumed.nonReplayable).toBeUndefined();
        expect(isNonReplayableResponse(consumed.response)).toBe(false);
        expect(consumed.response.status).toBe(400);
        expect(consumed.response.headers.get("retry-after")).toBeNull();
        expect(consumed.response.headers.get("x-should-retry")).toBeNull();
        const wire = await consumed.response.json();
        expect(wire.error.code).toBe("invalid_request_error");
        expect(wire.error.type).toBe("invalid_request_error");
      }
    }
  }
});

test("genuine hard codes retain formatter identity and non-replayable behavior with benign diagnostic types", async () => {
  for (const nested of [false, true]) {
    for (const code of ["cyber_policy", "upstream_no_response", "upstream_reset_replay_refused"]) {
      const record = { error: { code, type: "invalid_request_error", message: "fixture failure" } };
      const consumed = await consumeComboFailure(Response.json(nested ? { response: record } : record, { status: 400 }));
      expect(consumed.upstreamCode).toBe(code);
      expect((await consumed.response.json()).error.code).toBe(code);
      expect(consumed.response.status).toBe(code === "upstream_reset_replay_refused" ? 429 : 400);
      expect(isNonReplayableResponse(consumed.response)).toBe(code !== "cyber_policy");
      expect(consumed.response.headers.get("x-should-retry")).toBe(code === "upstream_reset_replay_refused" ? "false" : null);
    }
  }
});
