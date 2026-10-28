/**
 * A runTurn combo child hands the combo loop the failure its adapter already classified.
 * The child's status and code drive hop and cooldown decisions; the combo's own failure
 * consumer still decides what reaches the client.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "claude-opus-5-5";
const SIBLING_MODEL = "claude-sonnet-5-5";
let childFailure: AdapterEvent | undefined;
let runTurnCalls = 0;
let fallbackCalls = 0;

const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "cursor") return actualResolveAdapter(provider, cacheRetention);
    return {
      name: "cursor",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield { type: "error", message: "fixture uses runTurn" } as AdapterEvent; },
      async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: AdapterEvent) => void) {
        runTurnCalls++;
        if (childFailure) {
          emit(childFailure);
          return;
        }
        emit({ type: "text_delta", text: "cursor answered" });
        emit({ type: "done" });
      },
    } as unknown as ProviderAdapter;
  },
}));

const { handleResponses } = await import("../../src/server/responses");
const { formatErrorResponse } = await import("../../src/bridge");
const { SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE } = await import("../../src/lib/errors");
const { saveCredential } = await import("../../src/oauth/store");
const { clearComboSelectionState } = await import("../../src/combos/resolve");
const { clearComboTargetCooldowns } = await import("../../src/combos/failover");
const { clearGenericFailoverHealth } = await import("../../src/oauth/generic-account-failover");

function answer(init?: RequestInit): Response {
  fallbackCalls++;
  if ((JSON.parse(String(init?.body ?? "{}")) as { stream?: unknown }).stream !== true) {
    return Response.json({
      id: "msg_fallback", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: "fallback answered" }], stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  }
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event("message_start", { type: "message_start", message: { id: "msg_fallback", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fallback answered" } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    event("message_stop", { type: "message_stop" }),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function config(targets: Array<{ provider: string; model: string }>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "cursor",
    providers: {
      cursor: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", authMode: "oauth", models: [MODEL, SIBLING_MODEL] },
      fallback: {
        adapter: "anthropic", baseUrl: "https://fallback.test", authMode: "key",
        apiKey: "fixture-fallback-key", models: [MODEL],
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => answer(init)) as typeof fetch,
      } as OcxProviderConfig,
    },
    combos: { "classified-chain": { alias: "chain/classified", strategy: "failover", targets } },
  } as OcxConfig;
}

async function respond(cfg: OcxConfig, stream: boolean) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chain/classified", input: "describe this", stream }),
  }), cfg, { model: "", provider: "" });
  return { status: response.status, text: await response.text() };
}

let home = "";
let releaseSpendHome: (() => void) | undefined;
const originalHome = process.env.OPENCODEX_HOME;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-classified-failure-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  await saveCredential("cursor", { access: "cursor-access", refresh: "cursor-refresh", expires: Date.now() + 3_600_000, accountId: "cursor-account" });
  childFailure = undefined;
  runTurnCalls = 0;
  fallbackCalls = 0;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearGenericFailoverHealth();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState(); clearComboTargetCooldowns(); clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

for (const stream of [false, true]) {
  for (const status of [400, 422]) {
    for (const code of [undefined, "invalid_argument"]) {
      test(`reflected quota prose stays terminal through runTurn (stream=${stream}, status=${status}, code=${code})`, async () => {
        childFailure = {
          type: "error", status, code, errorType: "invalid_request_error",
          message: "Invalid parameter: value quotes 'weekly usage quota exceeded; quota exhausted'",
        };
        const cfg = config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]);
        const response = await respond(cfg, stream);
        expect(response.status).toBe(status);
        expect(runTurnCalls).toBe(1);
        expect(fallbackCalls).toBe(0);
        // A validation error did not cool the healthy provider for a later valid request.
        childFailure = undefined;
        const next = await respond(cfg, stream);
        expect(next.status).toBe(200);
        expect(next.text).toContain("cursor answered");
        expect(runTurnCalls).toBe(2);
        expect(fallbackCalls).toBe(0);
      });
    }
    test(`a structured spent window survives runTurn formatting (stream=${stream}, status=${status})`, async () => {
      childFailure = { type: "error", status, code: "usage_limit_reached", message: "Account window spent" };
      const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
      expect(response.status).toBe(200);
      expect(runTurnCalls).toBe(1);
      expect(fallbackCalls).toBe(1);
      expect(response.text).toContain("fallback answered");
    });
  }
  test(`a child that cannot take image input hands the turn to the next target (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 400, errorType: "invalid_request_error", code: "unsupported_input_modality",
      retryable: false, message: "Claude Code CLI image input is not enabled because the CLI provider route has no verified multimodal contract.",
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  test(`a child's insufficient_quota verdict survives to the exhausted combo (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 429, errorType: "insufficient_quota", code: "insufficient_quota",
      retryable: false, message: "Qoder credits are exhausted for this account.",
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }]), stream);
    expect(response.status).toBe(429);
    expect(JSON.parse(response.text).error).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
  });

  // The consumer truncates the child message to 500 characters, so a refusal phrase past that
  // point survives only as the child's own cyber_policy code.
  test(`a cyber-policy refusal read from a long message still stops the combo (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, errorType: "upstream_error", code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}This request was flagged for possible cybersecurity risk.`,
    };
    const response = await respond(config([{ provider: "cursor", model: MODEL }, { provider: "fallback", model: MODEL }]), stream);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text).error.code).toBe("cyber_policy");
    expect(fallbackCalls).toBe(0);
  });

  // A coding-agent CLI reports spent account quota as a generic 502 upstream_error; only the
  // message says quota. That verdict cools the whole provider, so the sibling model is skipped.
  test(`a quota verdict read from the message outranks a generic child code (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, errorType: "upstream_error", code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}Account quota exhausted.`,
    };
    const response = await respond(config([
      { provider: "cursor", model: MODEL }, { provider: "cursor", model: SIBLING_MODEL }, { provider: "fallback", model: MODEL },
    ]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
  });

  // Without an errorType the adapter infers authentication_error from the message, so that
  // inferred type must not make the message look as if it added nothing.
  test(`a credential verdict inferred from an untyped child still cools the provider (stream=${stream})`, async () => {
    childFailure = {
      type: "error", status: 502, code: "upstream_error",
      message: `${"Agent transcript detail. ".repeat(30)}Authentication failed.`,
    };
    const response = await respond(config([
      { provider: "cursor", model: MODEL }, { provider: "cursor", model: SIBLING_MODEL }, { provider: "fallback", model: MODEL },
    ]), stream);
    expect(response.status).toBe(200);
    expect(response.text).toContain("fallback answered");
    expect(runTurnCalls).toBe(1);
  });
}

test("a classified child failure keeps its verdict without displacing the formatter's own refusals", async () => {
  const quota = formatErrorResponse(429, "insufficient_quota", "credits exhausted", { code: "insufficient_quota", classified: true });
  expect(quota.status).toBe(429);
  expect((await quota.json()).error).toMatchObject({ type: "insufficient_quota", code: "insufficient_quota" });
  const storage = formatErrorResponse(429, "insufficient_quota", "ledger offline",
    { code: SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE, classified: true });
  expect(storage.status).toBe(503);
  expect((await storage.json()).error).toMatchObject({ type: "server_error", code: SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE });
  const cyber = formatErrorResponse(502, "upstream_error", "flagged", { code: "cyber_policy", classified: true });
  expect(cyber.status).toBe(400);
  expect((await cyber.json()).error.code).toBe("cyber_policy");
});
