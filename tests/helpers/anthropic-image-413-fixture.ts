import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import { attachRequestSpendTracker } from "../../src/server/responses/request-spend";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { configureSharedSpendLedger, parseSpendJournalRecord, SPEND_LEDGER_JOURNAL_FILENAME, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "./owned-spend-home";
import { removeTreeWithRetry } from "./remove-tree";

export const providerName = "anthropic-image-fixture";
export const target = "https://anthropic-image.example.test/v1/messages";
export const credential = "synthetic-image-fixture-key";
const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type Lane = "direct" | "search" | "media";
export interface WireSend {
  url: string;
  key: string | null;
  redirect: RequestRedirect | undefined;
  body: string;
}

export async function fixture(options: {
  enabled?: boolean;
  lane?: Lane;
  stream?: boolean;
  image?: "large" | "normal" | "none" | "newest-only";
  maxOutputTokens?: number;
  nativeOpus?: boolean;
  stallTimeoutSec?: number;
  reasoningDefault?: boolean;
  instructionRole?: "developer" | "system";
  spendCeiling?: number;
  terminalContinuation?: boolean;
  sendAllowance?: number;
  handle: (request: WireSend, index: number, config: OcxConfig) => Response | Promise<Response>;
  requestOptions?: Parameters<typeof handleResponses>[3];
}) {
  const home = mkdtempSync(join(tmpdir(), "ocx-image-recovery-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const sent: WireSend[] = [];
  try {
    const model = options.nativeOpus ? "claude-opus-5-5" : "claude-sonnet-4-5";
    const urlTarget = options.nativeOpus ? "https://api.anthropic.com/v1/messages" : target;
    const config: OcxConfig = {
      defaultProvider: providerName,
      emptyCompletionRetry: false,
      stallTimeoutSec: options.stallTimeoutSec,
      providers: {
        [providerName]: {
          adapter: "anthropic", baseUrl: urlTarget, authMode: "key", apiKey: credential, proxy: "direct",
          models: [model],
          ...(options.reasoningDefault ? { modelDefaultReasoningEfforts: { [model]: "high" } } : {}),
          ...(options.enabled === undefined ? {} : { anthropicImageContextRecovery: options.enabled }),
          requestPacing: { enabled: true, maxConcurrentRequests: 1 },
        },
      },
    } as OcxConfig;
    if (options.spendCeiling !== undefined) {
      configureSharedSpendLedger(spendPolicyFromConfig({ pool: { maxTokens: options.spendCeiling } }, undefined, [providerName]));
    }
    const tools = [];
    if (options.terminalContinuation) {
      tools.push({ type: "function", name: "exec_command", parameters: { type: "object" } });
    }
    if (options.lane === "search") {
      config.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-unused-search-key" };
      tools.push({ type: "web_search" });
    }
    if (options.lane === "media") {
      mkdirSync(join(home, "artifacts"));
      config.images = { bridgeEnabled: true };
      config.providers.xai = { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1",
        authMode: "key", apiKey: "synthetic-unused-media-key", proxy: "direct" };
      tools.push({ type: "image_generation" });
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const send = { url, key: new Headers(init?.headers).get("x-api-key"), redirect: init?.redirect, body: String(init?.body) };
      sent.push(send);
      if (url !== urlTarget) throw new Error("Unexpected synthetic image fixture destination");
      return options.handle(send, sent.length, config);
    }) as typeof fetch;
    const imageData = options.image === "large"
      ? Buffer.from(await new Bun.Image(Buffer.from(onePixel, "base64")).resize(2400, 2400).png().toBuffer()).toString("base64")
      : onePixel;
    const image = { type: "input_image", image_url: `data:image/png;base64,${imageData}` };
    const raw = {
      model: `${providerName}/${model}`, stream: options.stream ?? (options.lane !== undefined && options.lane !== "direct"),
      store: false, tools,
      max_output_tokens: options.maxOutputTokens,
      reasoning: options.reasoningDefault ? { effort: "none" } : undefined,
      input: [
        ...(options.instructionRole ? [{ type: "message", role: options.instructionRole,
          content: "Retain this instruction verbatim." }] : []),
        { type: "message", role: "user", content: [{ type: "input_text", text: `Older screenshot. ${"Archived context. ".repeat(120)}` },
          ...(!["none", "newest-only"].includes(options.image ?? "") ? [image] : [])] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Read the older screenshot" }] },
        { type: "message", role: "user", content: [
          { type: "input_text", text: `${options.terminalContinuation ? "Fix the code. " : ""}Keep the newest screenshot. ${"Recent context. ".repeat(200)}` },
          ...(options.image !== "none" ? [image] : []),
        ] },
      ],
    };
    const logCtx: Parameters<typeof handleResponses>[2] = { model: "", provider: "" };
    const request = new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "thread-id": "fixture-image-turn" },
      body: JSON.stringify(raw), signal: options.requestOptions?.abortSignal,
    });
    const sendBudget = options.sendAllowance === undefined ? options.requestOptions?.sendBudget
      : createRequestExecutionBudget({ maxTotalModelSends: options.sendAllowance, baseSendAllowance: options.sendAllowance,
        finalRecoveryAllowance: 0, maxAlternateTargetSends: 0, maxTargetTransitions: 0 },
      undefined, attachRequestSpendTracker(request, logCtx));
    const upstream = await handleResponses(request, config, logCtx, { ...options.requestOptions, sendBudget });
    const text = await upstream.text();
    logCtx.spendTracker?.settle(logCtx.usage);
    const journal = Bun.file(join(home, SPEND_LEDGER_JOURNAL_FILENAME));
    const spendRecords = options.spendCeiling !== undefined && await journal.exists()
      ? (await journal.text()).trim().split("\n").map(parseSpendJournalRecord)
      : undefined;
    return { sent, response: upstream, text, spendRecords,
      spendDispatchCount: spendRecords?.filter(record => record?.kind === "dispatch").length };
  } finally {
    try { release(); } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }
}

export function image413(type = "request_too_large"): Response {
  return Response.json({ type: "error", error: { type } }, { status: 413 });
}

function frame(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function imageToolCall(): Response {
  return new Response([
    frame("message_start", { message: {} }),
    frame("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_image", name: "image_gen", input: {} } }),
    frame("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    frame("content_block_stop", { index: 0 }),
    frame("message_delta", { delta: { stop_reason: "tool_use" } }),
    frame("message_stop"),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

export function completion(text: string, streaming = false, inputTokens = 10, outputTokens = 2): Response {
  if (!streaming) return Response.json({ content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
  return new Response([
    frame("message_start", { message: { usage: { input_tokens: inputTokens } } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } }),
    frame("message_stop"),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
