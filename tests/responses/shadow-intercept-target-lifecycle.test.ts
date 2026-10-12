/**
 * A shadow-call target whose provider is disabled or deleted (#5618).
 *
 * The management API reports the dependent intercept when the provider is disabled or deleted,
 * and the next intercepted helper call fails once with `intercept_target_unavailable` before any
 * upstream send. It is not passed through to the native model and not sent to the default
 * provider. Re-enabling the provider restores interception, a combo target keeps failing over
 * inside its declared members, and a bare target resolved through the default provider stays valid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses";
import { handleManagementAPI } from "../../src/server/management-api";
import {
  INTERCEPT_TARGET_UNAVAILABLE_CODE,
  INTERCEPT_TARGET_UNAVAILABLE_STATUS,
} from "../../src/server/responses/shadow-target-availability";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SOURCE = "gpt-5.6-luna";
const TARGET_MODEL = "helper-fast";
const TARGET = `helper/${TARGET_MODEL}`;

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

function useTempHome(): void {
  home = mkdtempSync(join(tmpdir(), "ocx-shadow-lifecycle-"));
  process.env.OPENCODEX_HOME = home;
}

function lifecycleConfig(shadowModel = TARGET): OcxConfig {
  return {
    port: 0,
    defaultProvider: "main",
    providers: {
      main: { adapter: "openai-chat", baseUrl: "https://main.example.test/v1", authMode: "key", apiKey: "test-main-key" },
      helper: {
        adapter: "openai-chat",
        baseUrl: "https://helper.example.test/v1",
        authMode: "key",
        apiKey: "test-helper-key",
        defaultModel: TARGET_MODEL,
      },
      spare: { adapter: "openai-chat", baseUrl: "https://spare.example.test/v1", authMode: "key", apiKey: "test-spare-key" },
    },
    shadowCallIntercept: { enabled: true, model: shadowModel },
  } as OcxConfig;
}

/** Records every upstream send and answers with a minimal chat completion. */
function captureUpstream(): Array<{ url: string; body: Record<string, unknown> }> {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;
  return sent;
}

async function helperCall(config: OcxConfig, logCtx: RequestLogContext = { model: "", provider: "" }): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: SOURCE,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "write a commit message" }] }],
      stream: false,
    }),
  }), config, logCtx);
}

async function manage(config: OcxConfig, method: string, path: string, body?: unknown): Promise<Response> {
  // The management API enforces a same-origin gate; a browserless caller must look local.
  const headers: Record<string, string> = { origin: "http://127.0.0.1:10100", host: "127.0.0.1:10100" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  expect(res).not.toBeNull();
  return res!;
}

async function expectUnavailable(response: Response, logCtx: RequestLogContext): Promise<string> {
  expect(response.status).toBe(INTERCEPT_TARGET_UNAVAILABLE_STATUS);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe(INTERCEPT_TARGET_UNAVAILABLE_CODE);
  expect(body.error.message).toContain(TARGET);
  expect(logCtx.errorCode).toBe(INTERCEPT_TARGET_UNAVAILABLE_CODE);
  return body.error.message;
}

describe("disabling or deleting the shadow-call target's provider", () => {
  test("disable reports the dependency and the next helper call fails once without a send", async () => {
    useTempHome();
    const config = lifecycleConfig();
    const sent = captureUpstream();

    const disable = await manage(config, "PATCH", "/api/providers?name=helper", { disabled: true });
    expect(disable.status).toBe(200);
    expect((await disable.json() as Record<string, unknown>).dependentShadowIntercept).toEqual({ model: TARGET, enabled: true });

    const logCtx: RequestLogContext = { model: "", provider: "" };
    await expectUnavailable(await helperCall(config, logCtx), logCtx);
    expect(sent).toEqual([]);
  });

  test("delete reports the dependency and the helper call is not sent to the default provider", async () => {
    useTempHome();
    const config = lifecycleConfig();
    const sent = captureUpstream();

    const remove = await manage(config, "DELETE", "/api/providers?name=helper");
    expect(remove.status).toBe(200);
    expect((await remove.json() as Record<string, unknown>).dependentShadowIntercept).toEqual({ model: TARGET, enabled: true });
    expect(config.providers.helper).toBeUndefined();

    const logCtx: RequestLogContext = { model: "", provider: "" };
    await expectUnavailable(await helperCall(config, logCtx), logCtx);
    expect(sent).toEqual([]);
  });

  test("an unrelated provider change reports nothing", async () => {
    useTempHome();
    const config = lifecycleConfig();
    const disable = await manage(config, "PATCH", "/api/providers?name=spare", { disabled: true });
    expect(disable.status).toBe(200);
    expect(await disable.json()).not.toHaveProperty("dependentShadowIntercept");
    const remove = await manage(config, "DELETE", "/api/providers?name=spare");
    expect(remove.status).toBe(200);
    expect(await remove.json()).not.toHaveProperty("dependentShadowIntercept");
  });

  test("re-enabling the provider restores interception", async () => {
    useTempHome();
    releaseSpendHome = acquireOwnedSpendHome();
    const config = lifecycleConfig();
    const sent = captureUpstream();

    expect((await manage(config, "PATCH", "/api/providers?name=helper", { disabled: true })).status).toBe(200);
    const enable = await manage(config, "PATCH", "/api/providers?name=helper", { disabled: false });
    expect(enable.status).toBe(200);
    expect(await enable.json()).not.toHaveProperty("dependentShadowIntercept");

    const response = await helperCall(config);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("helper.example.test");
    expect(String(sent[0]!.body.model)).toContain(TARGET_MODEL);
  });
});

describe("targets that keep an approved route", () => {
  test("a combo target fails over to its next declared member", async () => {
    useTempHome();
    releaseSpendHome = acquireOwnedSpendHome();
    const config = {
      ...lifecycleConfig("combo/shadow"),
      combos: {
        shadow: {
          strategy: "failover",
          targets: [{ provider: "helper", model: TARGET_MODEL }, { provider: "spare", model: "spare-fast" }],
        },
      },
    } as unknown as OcxConfig;
    config.providers.helper!.disabled = true;
    const sent = captureUpstream();

    const response = await helperCall(config);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("spare.example.test");
  });

  test("a bare target resolved through the default provider is still intercepted", async () => {
    useTempHome();
    releaseSpendHome = acquireOwnedSpendHome();
    const config = lifecycleConfig("house-helper");
    const sent = captureUpstream();

    const response = await helperCall(config);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("main.example.test");
    expect(String(sent[0]!.body.model)).toContain("house-helper");
  });
});

describe("the shadow-call settings API refuses a target with no configured provider", () => {
  test("PUT rejects a qualified target that only the default-provider fallback accepts", async () => {
    useTempHome();
    const config = lifecycleConfig();
    const response = await manage(config, "PUT", "/api/shadow-call-settings", { enabled: true, model: "retired/helper-fast" });
    expect(response.status).toBe(400);
    expect(config.shadowCallIntercept?.model).toBe(TARGET);
  });
});
