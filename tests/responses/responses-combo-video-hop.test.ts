/**
 * A combo whose first member cannot read a video moves on to one that can, without sending
 * anything to the first.
 *
 * The translated Chat builder refuses a video for a model that declares no video input with
 * 400 `unsupported_input_modality`. That code is a combo hop code, and the refusal is not
 * marked non-replayable (nothing was sent), so the combo loop reaches its hop decision instead
 * of ending on the first member's 400.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const { handleResponses } = await import("../../src/server/responses");
const { clearComboSelectionState } = await import("../../src/combos/resolve");
const { clearComboTargetCooldowns } = await import("../../src/combos/failover");
const { clearGenericFailoverHealth } = await import("../../src/oauth/generic-account-failover");

const CLIP = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
let blindSends = 0;
const videoBodies: string[] = [];

function chatAnswer(init?: RequestInit): Response {
  const body = String(init?.body ?? "{}");
  videoBodies.push(body);
  if ((JSON.parse(body) as { stream?: unknown }).stream !== true) {
    return Response.json({
      id: "chatcmpl-video", object: "chat.completion", created: 0, model: "kimi-k3.1-pro",
      choices: [{ index: 0, message: { role: "assistant", content: "saw the clip" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    });
  }
  const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  return new Response([
    chunk({ id: "chatcmpl-video", object: "chat.completion.chunk", created: 0, model: "kimi-k3.1-pro", choices: [{ index: 0, delta: { role: "assistant", content: "saw the clip" }, finish_reason: null }] }),
    chunk({ id: "chatcmpl-video", object: "chat.completion.chunk", created: 0, model: "kimi-k3.1-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function config(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "blind",
    providers: {
      blind: {
        adapter: "openai-chat", baseUrl: "https://blind.test/v1", authMode: "key", apiKey: "fixture-blind-key", models: ["text-only"],
        fetch: (async () => { blindSends++; return new Response("{}", { status: 500 }); }) as typeof fetch,
      } as OcxProviderConfig,
      sighted: {
        adapter: "openai-chat", baseUrl: "https://sighted.test/v1", authMode: "key", apiKey: "fixture-sighted-key", models: ["kimi-k3.1-pro"],
        modelInputModalities: { "kimi-k3.1-pro": ["text", "image", "video"] },
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => chatAnswer(init)) as typeof fetch,
      } as OcxProviderConfig,
    },
    combos: {
      "video-chain": {
        alias: "chain/video",
        strategy: "failover",
        targets: [{ provider: "blind", model: "text-only" }, { provider: "sighted", model: "kimi-k3.1-pro" }],
      },
    },
  } as OcxConfig;
}

let home = "";
let releaseSpendHome: (() => void) | undefined;
const originalHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-combo-video-hop-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
  blindSends = 0;
  videoBodies.length = 0;
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
  test(`a combo hops past a member without video input to one that declares it (stream=${stream})`, async () => {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chain/video",
        stream,
        input: [{ type: "message", role: "user", content: [
          { type: "input_text", text: "What happens in this clip?" },
          { type: "input_video", video_url: CLIP },
        ] }],
      }),
    }), config(), { model: "", provider: "" });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("saw the clip");
    expect(blindSends).toBe(0);
    expect(videoBodies).toHaveLength(1);
    const sent = JSON.parse(videoBodies[0]!) as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(sent.messages)).toContain(JSON.stringify({ type: "video_url", video_url: { url: CLIP } }));
  });
}
