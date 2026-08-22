import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oauthModule from "../src/oauth";

let oauthAccessError: Error | undefined;
mock.module("../src/oauth", () => ({
  ...oauthModule,
  getValidAccessToken: async () => {
    if (oauthAccessError) throw oauthAccessError;
    return "anthropic-vision-token";
  },
}));

import { CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../src/oauth/anthropic";
import { parseRequest } from "../src/responses/parser";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import {
  describeImagesInPlace,
  describeImageAnthropic,
  parseAnthropicVisionSSE,
  planVisionSidecar,
  type VisionPlan,
} from "../src/vision";

const DATA_IMAGE = "data:image/png;base64,aGVsbG8=";
const anthropicProvider: OcxProviderConfig = {
  adapter: "anthropic",
  authMode: "oauth",
  baseUrl: "https://api.anthropic.test/v1/",
};
const settings = { model: "claude-sonnet-5", timeoutMs: 5000 };
const AUTH_ERROR_CANARY = "\\\\server\\share\\opencodex\\auth.json.ocx-tmp /home/alice/.opencodex/auth.json.ocx-tmp";
const PUBLIC_OAUTH_ERROR = "OAuth authentication failed. Check the OpenCodex account status and retry.";

function sseResponse(
  frames: Array<Record<string, unknown> | string>,
  options: { crlf?: boolean; unterminated?: boolean; chunkSize?: number } = {},
): Response {
  const newline = options.crlf ? "\r\n" : "\n";
  let body = frames.map(frame => typeof frame === "string"
    ? `data: ${frame}${newline}${newline}`
    : `event: ${String(frame.type ?? "message")}${newline}data: ${JSON.stringify(frame)}${newline}${newline}`).join("");
  if (options.unterminated) body = body.replace(/(\r\n\r\n|\n\n)$/, "");
  return new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(body);
      const chunkSize = options.chunkSize ?? bytes.length;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function successSse(text = "A clear description"): Response {
  return sseResponse([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ]);
}

describe("Anthropic vision executor", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    oauthAccessError = undefined;
  });

  test("projects OAuth, upstream-auth, and transport failures onto safe replacement errors", async () => {
    oauthAccessError = new Error(`credential read failed at ${AUTH_ERROR_CANARY}`);
    const credentialFailure = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );
    expect(credentialFailure.error).toBe(`anthropic vision sidecar auth failed: ${PUBLIC_OAUTH_ERROR}`);
    expect(credentialFailure.error).not.toContain(AUTH_ERROR_CANARY);

    oauthAccessError = undefined;
    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 401 })) as typeof fetch;
    const upstreamAuthFailure = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );
    expect(upstreamAuthFailure.error).toBe(`anthropic vision sidecar auth failed: ${PUBLIC_OAUTH_ERROR}`);
    expect(upstreamAuthFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 403 })) as typeof fetch;
    const permissionFailure = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );
    expect(permissionFailure.error).toBe("anthropic vision sidecar HTTP 403");
    expect(permissionFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => new Response(AUTH_ERROR_CANARY, { status: 500 })) as typeof fetch;
    const upstreamFailure = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );
    expect(upstreamFailure.error).toBe("anthropic vision sidecar HTTP 500");
    expect(upstreamFailure.error).not.toContain(AUTH_ERROR_CANARY);

    globalThis.fetch = (async () => { throw new Error(`connect failed at ${AUTH_ERROR_CANARY}`); }) as typeof fetch;
    const transportFailure = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );
    expect(transportFailure.error).toBe("anthropic vision sidecar connect_error");
    expect(transportFailure.error).not.toContain(AUTH_ERROR_CANARY);

    oauthAccessError = new Error(`credential read failed at ${AUTH_ERROR_CANARY}`);
    const parsed = parseRequest({
      model: "routed/text-only",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe this image" },
          { type: "input_image", image_url: DATA_IMAGE },
        ],
      }],
    });
    const plan: VisionPlan = {
      backend: "anthropic",
      anthropicSidecar: { providerName: "anthropic-vision-test", provider: anthropicProvider },
      settings,
      maxDescriptionsPerTurn: 1,
    };
    await describeImagesInPlace(parsed, plan, new Headers());
    const projectedMessages = JSON.stringify(parsed.context.messages);
    const projectedRawBody = JSON.stringify(parsed._rawBody);
    expect(projectedMessages).toContain(PUBLIC_OAUTH_ERROR);
    expect(projectedRawBody).toContain(PUBLIC_OAUTH_ERROR);
    expect(projectedMessages).not.toContain(AUTH_ERROR_CANARY);
    expect(projectedRawBody).not.toContain(AUTH_ERROR_CANARY);
    expect(projectedRawBody).not.toContain(DATA_IMAGE);
  });

  test("a terminal stream error after partial text returns an error (never cacheable — review F1)", async () => {
    const res = sseResponse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "overloaded_error", message: AUTH_ERROR_CANARY } },
    ]);
    const out = await parseAnthropicVisionSSE(res);
    expect(out.text).toBe("");
    expect(out.error).toBe("anthropic vision sidecar stream error");
    expect(JSON.stringify(out)).not.toContain(AUTH_ERROR_CANARY);
  });

  test("POSTs /v1/messages with the Claude Code OAuth fingerprint and a base64 image block", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (url, init) => {
      captured = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return successSse("base64 description");
    }) as typeof fetch;

    const result = await describeImageAnthropic(
      DATA_IMAGE,
      "high",
      "read the screenshot",
      "anthropic-vision-test",
      anthropicProvider,
      settings,
    );

    expect(result).toEqual({ text: "base64 description" });
    expect(captured?.url).toBe("https://api.anthropic.test/v1/messages");
    expect(captured?.headers.get("authorization")).toBe("Bearer anthropic-vision-token");
    expect(captured?.headers.get("anthropic-beta")).toContain("oauth");
    expect(captured?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(captured?.headers.get("x-app")).toBe("cli");
    expect(captured?.headers.get("x-claude-code-session-id")).toBeTruthy();
    expect(captured?.headers.get("x-client-request-id")).toBeTruthy();
    expect(captured?.headers.get("user-agent")).toBe("@anthropic-ai/sdk/0.74.0");

    expect(captured?.body.model).toBe("claude-sonnet-5");
    expect(captured?.body.max_tokens).toBe(1024);
    expect(captured?.body.thinking).toEqual({ type: "disabled" });
    expect(captured?.body.stream).toBe(true);
    const system = captured?.body.system as Array<{ type: string; text: string }>;
    expect(system[0]).toEqual({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
    const messages = captured?.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0].content[0]).toEqual({ type: "text", text: "The user's request about this image: read the screenshot" });
    expect(messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
  });

  test("uses the Anthropic URL image source shape for https images", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return successSse();
    }) as typeof fetch;

    await describeImageAnthropic(
      "https://images.example/screenshot.png",
      undefined,
      "",
      "anthropic-vision-test",
      anthropicProvider,
      settings,
    );

    const messages = body?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0].content).toEqual([{
      type: "image",
      source: { type: "url", url: "https://images.example/screenshot.png" },
    }]);
  });

  test("extracts text deltas across CRLF chunks and an unterminated final frame", async () => {
    const result = await parseAnthropicVisionSSE(sseResponse([
      { type: "content_block_delta", delta: { type: "text_delta", text: "first " } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "second" } },
    ], { crlf: true, unterminated: true, chunkSize: 1 }));
    expect(result).toEqual({ text: "first second" });
  });

  test("malformed and terminal-error streams degrade to explicit errors", async () => {
    const malformed = await parseAnthropicVisionSSE(sseResponse(["{not-json", { type: "message_stop" }]));
    expect(malformed.text).toBe("");
    expect(malformed.error).toContain("produced no description");

    const terminal = await parseAnthropicVisionSSE(sseResponse([
      { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
    ], { unterminated: true }));
    expect(terminal).toEqual({ text: "", error: "anthropic vision sidecar stream error" });
  });

  test("returns graceful errors for aborts and timeouts and cancels the pending fetch", async () => {
    let aborts = 0;
    globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborts += 1;
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;

    const controller = new AbortController();
    const abortedPromise = describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, settings, controller.signal,
    );
    controller.abort(new DOMException("caller stopped", "AbortError"));
    const aborted = await abortedPromise;
    expect(aborted.error).toBeTruthy();

    const timedOut = await describeImageAnthropic(
      DATA_IMAGE, "high", "", "anthropic-vision-test", anthropicProvider, { ...settings, timeoutMs: 1 },
    );
    expect(timedOut.error).toBeTruthy();
    expect(aborts).toBeGreaterThanOrEqual(1);
  });

  test("matches vision input validation for base64 data and https-only remote images", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return successSse(); }) as typeof fetch;
    const invoke = (imageUrl: string) => describeImageAnthropic(
      imageUrl, "high", "", "anthropic-vision-test", anthropicProvider, settings,
    );

    expect((await invoke("data:text/plain;base64,aGVsbG8=")).error).toContain("unsupported image type");
    expect((await invoke("data:image/png,aGVsbG8=")).error).toContain("malformed data URL");
    expect((await invoke("http://images.example/a.png")).error).toContain("unsupported image URL scheme");
    expect((await invoke("file:///tmp/a.png")).error).toContain("unsupported image URL scheme");
    expect(calls).toBe(0);
  });
});

describe("Anthropic vision planning and management config", () => {
  test("explicit anthropic backend fails closed without a usable stored credential", async () => {
    const routed: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://routed.test/v1",
      noVisionModels: ["blind"],
    };
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "routed",
      providers: {
        routed,
        "anthropic-vision-no-credential-test": anthropicProvider,
      },
      visionSidecar: { backend: "anthropic" },
    };
    const request = parseRequest({
      model: "routed/blind",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_IMAGE }] }],
    });

    expect(planVisionSidecar(config, routed, "blind", request, new Headers({ authorization: "Bearer chatgpt" }))).toBeUndefined();
  });

  test("GET/PUT persists valid vision backend and cap and rejects invalid values", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-management-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const config: OcxConfig = { port: 10100, defaultProvider: "none", providers: {} };
    try {
      const put = await handleManagementAPI(
        new Request("http://localhost/api/sidecar-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // Auth-slot id: survives the #2188 membership gate on a config with
            // no providers, so the vision round-trip below still executes.
            webSearch: { model: "claude-haiku-4-5", backend: "anthropic", reasoning: "high" },
            vision: { model: "claude-sonnet-5", backend: "anthropic", maxDescriptionsPerTurn: 4 },
          }),
        }),
        new URL("http://localhost/api/sidecar-settings"),
        config,
      );
      expect(put.status).toBe(200);
      expect((await put.json()).vision).toEqual({
        enabled: true,
        model: "claude-sonnet-5",
        backend: "anthropic",
        reasoning: "low",
        maxDescriptionsPerTurn: 4,
        timeoutMs: 45_000,
      });
      expect(config.webSearchSidecar).toEqual({ model: "claude-haiku-4-5", backend: "anthropic", reasoning: "high" });

      const get = await handleManagementAPI(
        new Request("http://localhost/api/sidecar-settings"),
        new URL("http://localhost/api/sidecar-settings"),
        config,
      );
      const getBody = await get!.json() as Record<string, any>;
      expect(getBody.webSearch).toEqual({ model: "claude-haiku-4-5", backend: "anthropic", streamRoutedModelOutput: false });
      expect(getBody.vision).toEqual({
        enabled: true,
        model: "claude-sonnet-5",
        backend: "anthropic",
        reasoning: "low",
        maxDescriptionsPerTurn: 4,
        timeoutMs: 45_000,
      });

      const clear = await handleManagementAPI(
        new Request("http://localhost/api/sidecar-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            webSearch: { backend: null, model: "" },
            vision: { backend: null, model: "" },
          }),
        }),
        new URL("http://localhost/api/sidecar-settings"),
        config,
      );
      expect(clear.status).toBe(200);
      const clearBody = await clear.json() as Record<string, any>;
      expect(clearBody.webSearch).toEqual({ model: "gpt-5.6-luna", streamRoutedModelOutput: false });
      expect(clearBody.vision).toEqual({
        enabled: true,
        model: "gpt-5.4-mini",
        reasoning: "low",
        maxDescriptionsPerTurn: 4,
        timeoutMs: 45_000,
      });
      expect(config.webSearchSidecar).toEqual({ reasoning: "high" });
      expect(config.visionSidecar).toEqual({ maxDescriptionsPerTurn: 4 });

      for (const vision of [
        { backend: "other" },
        { maxDescriptionsPerTurn: 0 },
        { maxDescriptionsPerTurn: -1 },
        { maxDescriptionsPerTurn: 1.5 },
      ]) {
        const invalid = await handleManagementAPI(
          new Request("http://localhost/api/sidecar-settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vision }),
          }),
          new URL("http://localhost/api/sidecar-settings"),
          config,
        );
        expect(invalid?.status).toBe(400);
      }
      const invalidWebBackend = await handleManagementAPI(
        new Request("http://localhost/api/sidecar-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ webSearch: { backend: "other" } }),
        }),
        new URL("http://localhost/api/sidecar-settings"),
        config,
      );
      expect(invalidWebBackend?.status).toBe(400);
      expect(config.webSearchSidecar).toEqual({ reasoning: "high" });
      expect(config.visionSidecar).toEqual({ maxDescriptionsPerTurn: 4 });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  test("PUT rejects malformed body shapes with 400 and never persists them (review F2)", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-management-malformed-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const config: OcxConfig = { port: 10100, defaultProvider: "none", providers: {} };
    try {
      for (const raw of ["null", "[]", "\"str\"", "123",
        JSON.stringify({ vision: [] }), JSON.stringify({ vision: "bad" }),
        JSON.stringify({ vision: null }), JSON.stringify({ webSearch: 7 })]) {
        const resp = await handleManagementAPI(
          new Request("http://localhost/api/sidecar-settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: raw,
          }),
          new URL("http://localhost/api/sidecar-settings"),
          config,
        );
        expect(resp?.status).toBe(400);
      }
      // No malformed request mutated the config.
      expect(config.visionSidecar).toBeUndefined();
      expect(config.webSearchSidecar).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
