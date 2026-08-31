import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const SECRET = "sk_live_abcdefghijklmnopqrstuvwx";
const PLACEHOLDER = "<STRIPE_ACCESS_TOKEN_1>";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-guardrails-chat-native-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-guardrails-chat-native-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "test-key",
        allowPrivateNetwork: true,
        models: ["test-model"],
      },
    },
    guardrails: {
      enabled: true,
      mode: "enforce",
      failurePolicy: "block",
    },
  } as OcxConfig;
}

function requestBody(stream: boolean): Record<string, unknown> {
  return {
    model: "mock/test-model",
    stream,
    messages: [{ role: "user", content: `protect ${SECRET}` }],
  };
}

function canonicalChatResponse(body: string): string {
  return body.split("\n").map(line => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
    const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
    delete payload.id;
    delete payload.created;
    return `data: ${JSON.stringify(payload)}`;
  }).join("\n");
}

test("disabled Guardrails matches baseline native Chat JSON and SSE", async () => {
  const captured: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      captured.push(body);
      const parsed = JSON.parse(body) as { stream?: boolean };
      if (parsed.stream === true) {
        return new Response([
          `data: ${JSON.stringify({
            choices: [{
              index: 0,
              delta: { role: "assistant", content: "baseline" },
            }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "chatcmpl-disabled-differential",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "baseline" },
          finish_reason: "stop",
        }],
      });
    },
  });
  const baseUrl = `${upstream.url.toString().replace(/\/$/, "")}/v1`;
  const exercise = async (
    candidate: OcxConfig,
    stream: boolean,
  ): Promise<{ body: string; contentType: string | null; status: number }> => {
    saveConfig(candidate);
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody(stream)),
      });
      return {
        body: await response.text(),
        contentType: response.headers.get("content-type"),
        status: response.status,
      };
    } finally {
      await server.stop(true);
    }
  };

  try {
    for (const stream of [false, true]) {
      const baselineConfig = config(baseUrl);
      delete baselineConfig.guardrails;
      const baseline = await exercise(baselineConfig, stream);
      const disabledConfig = config(baseUrl);
      disabledConfig.guardrails = { enabled: false };
      const disabled = await exercise(disabledConfig, stream);
      const upstreamBodies = captured.splice(0, 2);

      expect(disabled.status, `stream=${stream}`).toBe(baseline.status);
      expect(disabled.contentType, `stream=${stream}`).toBe(baseline.contentType);
      expect(canonicalChatResponse(disabled.body), `stream=${stream}`)
        .toBe(canonicalChatResponse(baseline.body));
      expect(upstreamBodies[1], `stream=${stream}`).toBe(upstreamBodies[0]);
    }
  } finally {
    upstream.stop(true);
  }
});

test("Guardrails masks native Chat JSON upstream and demasks assistant content", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      return Response.json({
        id: "chatcmpl-guardrails-json",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: `echo ${PLACEHOLDER}` },
          finish_reason: "stop",
        }],
      });
    },
  });
  saveConfig(config(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);

  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(false)),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const upstreamText = JSON.stringify(captured);

    expect(captured).toHaveLength(1);
    expect(upstreamText).toContain(PLACEHOLDER);
    expect(upstreamText).not.toContain(SECRET);
    expect(responseText).toContain(SECRET);
    expect(responseText).not.toContain(PLACEHOLDER);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("provider scope leaves an excluded native Chat route unchanged", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      return Response.json({
        id: "chatcmpl-guardrails-excluded",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: `literal ${PLACEHOLDER}` },
          finish_reason: "stop",
        }],
      });
    },
  });
  const scoped = config(`${upstream.url.toString().replace(/\/$/, "")}/v1`);
  scoped.guardrails!.providerScope = {
    mode: "selected",
    providerIds: ["other"],
  };
  saveConfig(scoped);
  const server = startServer(0);

  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(false)),
    });
    const responseText = await response.text();
    const upstreamText = JSON.stringify(captured);

    expect(response.status).toBe(200);
    expect(upstreamText).toContain(SECRET);
    expect(upstreamText).not.toContain(PLACEHOLDER);
    expect(responseText).toContain(PLACEHOLDER);
    expect(responseText).not.toContain(`literal ${SECRET}`);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails demasks a placeholder split across native Chat SSE events", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push(await req.json() as Record<string, unknown>);
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "echo <STRIPE_ACCESS" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "_TOKEN_1>" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  saveConfig(config(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);

  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(true)),
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    const content = responseText
      .split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)) as {
        choices?: Array<{ delta?: { content?: unknown } }>;
      })
      .map(payload => payload.choices?.[0]?.delta?.content)
      .filter((value): value is string => typeof value === "string")
      .join("");

    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
    expect(content).toBe(`echo ${SECRET}`);
    expect(responseText).not.toContain("<STRIPE_ACCESS");
    expect(responseText).not.toContain("_TOKEN_1>");
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});
