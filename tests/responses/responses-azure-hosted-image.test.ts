import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { clientFacingModelLabel } from "../../src/lib/error-destination";
import { isNonReplayableResponse } from "../../src/lib/upstream-retry";
import { registerUpstreamRewriter, resetUpstreamRewritersForTests } from "../../src/plugins/upstream-hooks";
import { admissionModelScopeOf, AdmissionModelDeniedError, type AdmissionModelScope } from "../../src/server/admission-model-scope";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponses as handleResponsesWithFallback } from "../../src/server/responses";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { AZURE_IMAGE_DEPLOYMENT_HEADER as HEADER, AzureHostedImageError,
  azureHostedImageRefusalResponse, createAzureHostedImageGuard } from "../../src/server/responses/azure-hosted-image";
import { adapterBuildRefusal, passthroughBuildErrorResponse } from "../../src/server/responses/passthrough-build-error";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MAIN = "gpt-6-astra";
const IMAGE = "fixture-image-deployment";
const URL = "https://azure.example.test/openai/v1/responses";
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseHome: (() => void) | undefined;
let sent: { headers: Headers; body: Record<string, unknown> }[];

function provider(): OcxProviderConfig {
  return { adapter: "azure-openai", baseUrl: "https://azure.example.test/openai/v1",
    authMode: "key", apiKey: "fixture-azure-key", headers: { [HEADER]: IMAGE } };
}
function config(models?: string[]): OcxConfig {
  return { defaultProvider: "azure", providers: { azure: provider() },
    apiKeys: [{ id: "scoped", name: "fixture", key: "ocx_data_" + "a".repeat(40),
      createdAt: "2026-01-01T00:00:00.000Z", allowedModels: models }] } as OcxConfig;
}
function request(body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "azure/" + MAIN, input: [{ role: "user", content: "A fixture image" }],
      stream: false, tools: [{ type: "image_generation" }], ...body }) });
}
const admission = { kind: "configured", keyId: "scoped", source: "bearer" } as const;
const log = (): RequestLogContext => ({ provider: "azure", model: MAIN });
const success = () => Response.json({ id: "resp_fixture", object: "response", status: "completed", model: MAIN, output: [] });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-azure-image-"));
  process.env.OPENCODEX_HOME = home;
  releaseHome = acquireOwnedSpendHome();
  sent = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  globalThis.fetch = (async (_input, init) => {
    sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return success();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUpstreamRewritersForTests();
  releaseHome?.();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("Azure hosted image admission", () => {
  test("Astra-only scope refuses the image deployment before sending", async () => {
    const ctx = log();
    const response = await handleResponses(request(), config([MAIN]), ctx, { admission });
    expect(response.status).toBe(403);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(await response.json()).toMatchObject({ error: { type: "model_not_allowed_for_key", model: "azure/" + MAIN } });
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(ctx)).not.toContain(IMAGE);
  });
  for (const allowed of [[MAIN, IMAGE], ["azure/" + MAIN, "azure/" + IMAGE], undefined]) {
    test(`both destinations or unrestricted scope sends once: ${JSON.stringify(allowed)}`, async () => {
      const response = await handleResponses(request(), config(allowed), log(), { admission });
      expect(response.status).toBe(200);
      await response.text();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers.get(HEADER)).toBe(IMAGE);
    });
  }
  test("client deployment headers cannot choose the image destination", async () => {
    const cfg = config([MAIN, IMAGE]);
    cfg.providers.azure!.forwardClientHeaders = [HEADER] as OcxProviderConfig["forwardClientHeaders"];
    const response = await handleResponses(request({}, { [HEADER]: "client-other-deployment" }), cfg, log(), { admission });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent[0]!.headers.get(HEADER)).toBe(IMAGE);
  });
  for (const headers of [{}, { [HEADER]: "" }, { [HEADER]: "a,b" }, { [HEADER]: " padded " },
    { [HEADER]: IMAGE, [HEADER.toUpperCase()]: IMAGE }]) {
    test(`invalid operator header fails closed: ${JSON.stringify(headers)}`, async () => {
      const cfg = config();
      cfg.providers.azure!.headers = headers;
      const response = await handleResponses(request(), cfg, log(), { admission });
      expect(response.status).toBe(400);
      expect(isNonReplayableResponse(response)).toBe(true);
      expect(await response.text()).not.toContain(IMAGE);
      expect(sent).toHaveLength(0);
    });
  }
  test("mixed-case single operator header and matching tool model are accepted", async () => {
    const cfg = config([MAIN, IMAGE]);
    cfg.providers.azure!.headers = { [HEADER.toUpperCase()]: IMAGE };
    const response = await handleResponses(request({ tools: [{ type: "image_generation", model: IMAGE }] }), cfg, log(), { admission });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toHaveLength(1);
  });
  for (const model of ["different", "auto", null, 7]) {
    test(`a conflicting explicit tool model is not sent: ${JSON.stringify(model)}`, async () => {
      const response = await handleResponses(request({ tools: [{ type: "image_generation", model }] }), config(), log(), { admission });
      expect(response.status).toBe(400);
      expect(sent).toHaveLength(0);
    });
  }
  test("additional_tools cannot bypass scope", async () => {
    const response = await handleResponses(request({ tools: [], input: [
      { type: "additional_tools", tools: [{ type: "image_generation" }] }, { role: "user", content: "fixture" },
    ] }), config([MAIN]), log(), { admission });
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  test("image_gen lowered to a hosted tool is checked after normalization", async () => {
    const cfg = config([MAIN]);
    cfg.providers.azure!.modelPreferHostedTools = { [MAIN]: ["image_generation"] };
    const response = await handleResponses(request({ tools: [{ type: "function", name: "image_gen", parameters: { type: "object" } }] }), cfg, log(), { admission });
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  test("text, image input and client functions do not require image-generation consent", async () => {
    const cfg = config([MAIN]);
    cfg.providers.azure!.headers = {};
    for (const body of [{ tools: [] }, { tools: [{ type: "function", name: "image_generation", parameters: { type: "object" } }] },
      { tools: [], input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }] }]) {
      const response = await handleResponses(request(body), cfg, log(), { admission });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(sent).toHaveLength(3);
  });
  for (const mutation of ["header", "url"] as const) {
    test(`final plugin ${mutation} rewrites refuse before physical dispatch`, async () => {
      registerUpstreamRewriter("fixture", target => {
        if (mutation === "header") target.headers.set(HEADER, "other-private-deployment");
        else target.url = "https://other-private.example.test/responses";
      });
      const ctx = log();
      const response = await handleResponses(request(), config([MAIN, IMAGE]), ctx, { admission });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "azure_image_deployment_required" } });
      expect(sent).toHaveLength(0);
      expect(JSON.stringify(ctx)).not.toContain("other-private");
    });
  }
  for (const changeOnRetry of [false, true]) {
    test(`opaque-state recovery rechecks the rebuilt request: changed=${changeOnRetry}`, async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls > 1) return success();
        return Response.json({ error: { type: "invalid_request_error", code: "invalid_encrypted_content",
          message: "The encrypted content could not be verified" } }, { status: 400 });
      }) as typeof fetch;
      registerUpstreamRewriter("fixture", target => {
        if (changeOnRetry && calls > 0) target.headers.set(HEADER, "other-private-deployment");
      });
      const response = await handleResponses(request({ input: [
        { type: "reasoning", id: "rs_foreign", summary: [], encrypted_content: "foreign-ciphertext" },
        { role: "user", content: "fixture" },
      ] }), config([MAIN, IMAGE]), log(), { admission });
      expect(response.status).toBe(changeOnRetry ? 400 : 200);
      if (changeOnRetry) expect(await response.json()).toMatchObject({ error: { code: "azure_image_deployment_required" } });
      else await response.text();
      expect(calls).toBe(changeOnRetry ? 1 : 2);
    });
  }
  test("non-Azure providers retain their existing hosted-tool behavior", async () => {
    const cfg = config([MAIN]);
    cfg.providers.azure = { ...provider(), adapter: "openai-responses", baseUrl: "https://responses.example.test/v1", headers: {} };
    const response = await handleResponses(request(), cfg, log(), { admission });
    expect(response.status).toBe(200);
    await response.text();
    expect(sent).toHaveLength(1);
  });
  for (const route of ["combo", "policy"] as const) for (const refusal of ["configuration", "scope"] as const) {
    test(`${route} preserves a terminal ${refusal} refusal without a fallback send`, async () => {
      const selector = `${route}/image-fixture`;
      const cfg = config(refusal === "scope" ? [selector, MAIN] : undefined);
      cfg.providers.azure!.models = [MAIN];
      cfg.providers.azure!.liveModels = false;
      if (refusal === "configuration") cfg.providers.azure!.headers = {};
      cfg.providers.backup = { ...provider(), adapter: "openai-responses",
        baseUrl: "https://backup.example.test/v1", models: [MAIN], liveModels: false, headers: {} };
      const targets = [{ provider: "azure", model: MAIN }, { provider: "backup", model: MAIN }];
      if (route === "combo") cfg.combos = { "image-fixture": { strategy: "failover", targets } };
      else cfg.routingProfiles = { "image-fixture": { candidates: targets } };
      const ctx = log();
      const response = await handleResponsesWithFallback(request({ model: selector }), cfg, ctx, { admission });
      expect(response.status).toBe(refusal === "scope" ? 403 : 400);
      expect(isNonReplayableResponse(response)).toBe(true);
      const body = await response.text();
      expect(body).toContain(refusal === "scope" ? "model_not_allowed_for_key" : "azure_image_deployment_required");
      expect(body).not.toContain(IMAGE);
      expect(sent).toHaveLength(0);
    });
  }
  test("an ambiguous hosted-image reset never retries or falls through the combo", async () => {
    const cfg = config();
    cfg.providers.azure!.retryOnReset = {};
    cfg.providers.backup = { ...provider(), adapter: "openai-responses", baseUrl: "https://backup.example.test/v1" };
    cfg.combos = { "image-reset": { strategy: "failover", targets: [
      { provider: "azure", model: MAIN }, { provider: "backup", model: MAIN },
    ] } };
    globalThis.fetch = (async (_input, init) => {
      sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
    }) as typeof fetch;
    const response = await handleResponsesWithFallback(request({ model: "combo/image-reset" }), cfg, log(), { admission });
    expect(response.status).toBe(429);
    expect(isNonReplayableResponse(response)).toBe(true);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toMatchObject({ error: { code: "upstream_reset_replay_refused" } });
    expect(sent).toHaveLength(1);
  });
});

describe("captured Azure image authority", () => {
  const body = JSON.stringify({ model: MAIN, tools: [{ type: "image_generation" }] });
  const headers = () => new Headers({ [HEADER]: IMAGE });
  function guard(scope?: AdmissionModelScope, cfg = provider()) {
    return createAzureHostedImageGuard("azure", cfg, URL, scope, clientFacingModelLabel("my-alias"), log());
  }
  test("provider and inherited restrictions both apply", () => {
    for (const scope of [admissionModelScopeOf({ allowedProviders: ["elsewhere"] }),
      { providers: [], models: [], allOf: [admissionModelScopeOf({ allowedModels: [MAIN, IMAGE] })!,
        admissionModelScopeOf({ allowedModels: [MAIN] })!] }]) {
      expect(() => guard(scope)(body, headers(), URL)).toThrow(AdmissionModelDeniedError);
    }
  });
  test("the final main model is also scoped", () => {
    expect(() => guard(admissionModelScopeOf({ allowedModels: [IMAGE] }))(body, headers(), URL)).toThrow(AdmissionModelDeniedError);
  });
  test("operator and scope mutations do not change a captured binding", () => {
    const cfg = provider();
    const scope = { providers: [], models: [MAIN] };
    const check = guard(scope, cfg);
    scope.models.push(IMAGE);
    cfg.headers![HEADER] = "other";
    expect(() => check(body, headers(), URL)).toThrow(AdmissionModelDeniedError);
  });
  test("text-only binding checks a later hosted declaration and effective body", () => {
    const check = guard(admissionModelScopeOf({ allowedModels: [MAIN] }));
    expect(check(JSON.stringify({ model: MAIN, tools: [] }), headers(), URL)).toBeUndefined();
    expect(() => check(body, headers(), URL)).toThrow(AdmissionModelDeniedError);
  });
  test("dispatch and final physical header or URL changes fail closed", () => {
    const check = guard();
    for (const [target, h] of [[URL, new Headers()], [URL, new Headers({ [HEADER]: "other" })],
      ["https://elsewhere.test/responses", headers()]] as const) {
      expect(() => check(body, h, target)).toThrow(AzureHostedImageError);
      expect(() => check(body, headers(), URL)!(target, h)).toThrow(AzureHostedImageError);
    }
  });
  test("local refusals are non-replayable on initial and rebuilt requests", () => {
    const denied = new AdmissionModelDeniedError(clientFacingModelLabel("my-alias"), { providerName: "azure", modelId: IMAGE });
    for (const error of [new AzureHostedImageError(), denied]) {
      let cleaned = 0;
      const responses = [azureHostedImageRefusalResponse(error), passthroughBuildErrorResponse(error),
        adapterBuildRefusal(error, undefined, undefined, () => { cleaned++; })];
      for (const response of responses) {
        expect(response?.status).toBe(error === denied ? 403 : 400);
        expect(isNonReplayableResponse(response!)).toBe(true);
      }
      expect(cleaned).toBe(1);
    }
  });
});
