import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { managementFetch } from "./helpers/management-auth";

setDefaultTimeout(15_000);

let testHome = "";
let previousOpenCodexHome: string | undefined;
let previousAdminAuthToken: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousAdminAuthToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  isolatedCodexHome = installIsolatedCodexHome("ocx-guardrails-e2e-codex-");
  testHome = mkdtempSync(join(tmpdir(), "ocx-guardrails-e2e-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "guardrails-e2e-admin-token";
});

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousAdminAuthToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminAuthToken;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testHome && existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

test("Guardrails masks upstream input and restores a real proxy JSON response", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamInput = "";
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/responses");
      const body = await request.json() as { input?: unknown };
      upstreamInput = typeof body.input === "string" ? body.input : "";
      return Response.json({
        id: "resp-guardrails-e2e",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "echo <STRIPE_ACCESS_TOKEN_1>" }],
        }],
      });
    },
  });
  try {
    saveConfig({
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", input: secret, stream: false }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const responseBody = await response.json() as {
      output?: Array<{ content?: Array<{ text?: unknown }> }>;
    };
    expect(upstreamInput).toBe("<STRIPE_ACCESS_TOKEN_1>");
    expect(upstreamInput).not.toContain(secret);
    expect(responseBody.output?.[0]?.content?.[0]?.text).toBe(`echo ${secret}`);
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails detect mode leaves a real Responses request and response unchanged", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody = "";
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBody = await request.text();
      return Response.json({
        id: "resp-guardrails-detect-e2e",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `unchanged ${secret}` }],
        }],
      });
    },
  });
  try {
    saveConfig({
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode: "detect", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", input: secret, stream: false }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toContain(secret);
    expect(upstreamBody).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
    expect(await response.text()).toContain(`unchanged ${secret}`);
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails compact detect, block, and passthrough policies hold at the proxy wire boundary", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const oversizedInput = `${secret} ${"x".repeat(128 * 1024)}`;
  const upstreamBodies: string[] = [];
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBodies.push(await request.text());
      return Response.json({
        id: "resp-guardrails-compact-wire",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "compact summary" }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  const startProxy = (
    mode: NonNullable<OcxConfig["guardrails"]>["mode"],
    failurePolicy: NonNullable<OcxConfig["guardrails"]>["failurePolicy"],
  ) => {
    saveConfig({
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode, failurePolicy },
    } as OcxConfig);
    return startServer(0);
  };
  const compact = (input: string) => fetch(new URL("/v1/responses/compact", proxy!.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/test-model",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input }],
      }],
    }),
  });

  try {
    proxy = startProxy("detect", "block");
    const detected = await compact(secret);
    expect(detected.status).toBe(200);
    await detected.body?.cancel();
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0]).toContain(secret);
    expect(upstreamBodies[0]).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
    await proxy.stop(true);
    proxy = null;

    proxy = startProxy("enforce", "block");
    const blocked = await compact(oversizedInput);
    expect(blocked.status).toBe(413);
    await blocked.body?.cancel();
    expect(upstreamBodies).toHaveLength(1);
    await proxy.stop(true);
    proxy = null;

    proxy = startProxy("enforce", "passthrough");
    const passedThrough = await compact(oversizedInput);
    expect(passedThrough.status).toBe(200);
    await passedThrough.body?.cancel();
    expect(upstreamBodies).toHaveLength(2);
    const passedThroughWire = JSON.parse(upstreamBodies[1]!) as {
      input?: Array<{ content?: Array<{ text?: unknown }> }>;
    };
    const passedThroughTexts = passedThroughWire.input
      ?.flatMap(item => item.content ?? [])
      .map(item => item.text)
      .filter((text): text is string => typeof text === "string") ?? [];
    expect(passedThroughTexts).toContain(oversizedInput);
    expect(upstreamBodies[1]).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails masks and demasks a real client-facing Responses WebSocket turn", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody = "";
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBody = await request.text();
      const completed = {
        type: "response.completed",
        response: {
          id: "resp-guardrails-client-ws",
          object: "response",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "echo <STRIPE_ACCESS_TOKEN_1>" }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      };
      return new Response([
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: "item-guardrails-ws",
          output_index: 0,
          content_index: 0,
          delta: "echo <STRIPE_ACCESS_TOKEN_1>",
        })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({
          type: "response.output_text.done",
          item_id: "item-guardrails-ws",
          output_index: 0,
          content_index: 0,
          text: "echo <STRIPE_ACCESS_TOKEN_1>",
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    saveConfig({
      port: 0,
      websockets: true,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const url = new URL("/v1/responses", proxy.url);
    url.protocol = "ws:";
    const frames = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Guardrails client WebSocket timeout"));
      }, 5_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "response.create",
          model: "mock/test-model",
          input: secret,
        }));
      }, { once: true });
      socket.addEventListener("message", event => {
        const frame = typeof event.data === "string" ? event.data : "";
        received.push(frame);
        if (!frame.includes('"type":"response.completed"')) return;
        clearTimeout(timer);
        socket.close();
        resolve(received);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Guardrails client WebSocket failed"));
      }, { once: true });
    });

    expect(upstreamBody).toContain("<STRIPE_ACCESS_TOKEN_1>");
    expect(upstreamBody).not.toContain(secret);
    expect(frames.join("\n")).toContain(secret);
    expect(frames.join("\n")).not.toContain("<STRIPE_ACCESS_TOKEN_1>");
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails never restores secrets into a client-facing WebSocket failure envelope", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  let upstreamBody = "";
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBody = await request.text();
      const failed = {
        type: "response.failed",
        response: {
          id: "resp-guardrails-client-ws-failed",
          object: "response",
          status: "failed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hidden <STRIPE_ACCESS_TOKEN_1>" }],
          }],
          error: { message: "provider rejected <STRIPE_ACCESS_TOKEN_1>" },
        },
      };
      return new Response(
        `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    saveConfig({
      port: 0,
      websockets: true,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const url = new URL("/v1/responses", proxy.url);
    url.protocol = "ws:";
    const frames = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Guardrails failed WebSocket timeout"));
      }, 5_000);
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "response.create",
          model: "mock/test-model",
          input: secret,
        }));
      }, { once: true });
      socket.addEventListener("message", event => {
        const frame = typeof event.data === "string" ? event.data : "";
        received.push(frame);
        if (!frame.includes('"type":"response.failed"')) return;
        clearTimeout(timer);
        socket.close();
        resolve(received);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Guardrails failed client WebSocket failed"));
      }, { once: true });
    });
    const wire = frames.join("\n");

    expect(upstreamBody).toContain("<STRIPE_ACCESS_TOKEN_1>");
    expect(upstreamBody).not.toContain(secret);
    expect(wire).toContain("<STRIPE_ACCESS_TOKEN_1>");
    expect(wire).not.toContain(secret);
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails masks native Responses input_file names and preserves file bytes", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const fileData = "ZmlsZQ==";
  let upstreamBody: Record<string, unknown> | undefined;
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBody = await request.json() as Record<string, unknown>;
      return Response.json({
        id: "resp-guardrails-file-native",
        object: "response",
        status: "completed",
        output: [],
      });
    },
  });
  try {
    saveConfig({
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_file", filename: secret, file_data: fileData }],
        }],
      }),
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
    const upstreamText = JSON.stringify(upstreamBody);
    expect(upstreamText).toContain("<STRIPE_ACCESS_TOKEN_1>");
    expect(upstreamText).not.toContain(secret);
    expect(upstreamText).toContain(fileData);
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails masks routed input_file markers and never forwards file bytes", async () => {
  const secret = "sk_live_abcdefghijklmnopqrstuvwx";
  const fileData = "ZmlsZQ==";
  let upstreamBody: Record<string, unknown> | undefined;
  let proxy: ReturnType<typeof startServer> | null = null;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      upstreamBody = await request.json() as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl-guardrails-file-routed",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
      });
    },
  });
  try {
    saveConfig({
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: "openai-chat",
          authMode: "key",
          apiKey: "test-only-key",
          baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
          allowPrivateNetwork: true,
          models: ["test-model"],
        },
      },
      guardrails: { enabled: true, mode: "enforce", failurePolicy: "block" },
    } as OcxConfig);
    proxy = startServer(0);
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_file", filename: secret, file_data: fileData }],
        }],
      }),
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
    const upstreamText = JSON.stringify(upstreamBody);
    expect(upstreamText).toContain("[file: <STRIPE_ACCESS_TOKEN_1>]");
    expect(upstreamText).not.toContain(secret);
    expect(upstreamText).not.toContain(fileData);
  } finally {
    await proxy?.stop(true);
    upstream.stop(true);
  }
});

test("Guardrails provider scope protects selected traffic and leaves excluded traffic untouched", async () => {
  const protectedSecret = "sk_live_abcdefghijklmnopqrstuvwx";
  const excludedSecret = "sk_live_zyxwvutsrqponmlkjihgfedc";
  let protectedUpstreamInput = "";
  let excludedUpstreamInput = "";
  let proxy: ReturnType<typeof startServer> | null = null;
  const protectedUpstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as { input?: unknown };
      protectedUpstreamInput = typeof body.input === "string" ? body.input : "";
      return Response.json({
        id: "resp-provider-scope-protected",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "protected <STRIPE_ACCESS_TOKEN_1>" }],
        }],
      });
    },
  });
  const excludedUpstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as { input?: unknown };
      excludedUpstreamInput = typeof body.input === "string" ? body.input : "";
      return Response.json({
        id: "resp-provider-scope-excluded",
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "excluded <STRIPE_ACCESS_TOKEN_1>" }],
        }],
      });
    },
  });
  try {
    saveConfig({
      port: 0,
      defaultProvider: "protected",
      providers: {
        protected: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-protected-key",
          baseUrl: protectedUpstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
        excluded: {
          adapter: "openai-responses",
          authMode: "key",
          apiKey: "test-only-excluded-key",
          baseUrl: excludedUpstream.url.toString().replace(/\/$/, ""),
          responsesPath: "/responses",
          allowPrivateNetwork: true,
        },
      },
      guardrails: {
        enabled: true,
        mode: "enforce",
        failurePolicy: "block",
        providerScope: { mode: "selected", providerIds: ["protected"] },
      },
    } as OcxConfig);
    proxy = startServer(0);

    const settingsResponse = await managementFetch(new URL("/api/guardrails", proxy.url));
    expect(settingsResponse.status).toBe(200);
    const settings = await settingsResponse.json() as {
      providerScope?: unknown;
      providerOptions?: Array<{ id?: unknown }>;
    };
    expect(settings.providerScope).toEqual({
      mode: "selected",
      providerIds: ["protected"],
    });
    expect(settings.providerOptions?.map(option => option.id)).toEqual(
      expect.arrayContaining(["protected", "excluded", "anthropic-native"]),
    );

    const protectedResponse = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "protected/test-model",
        input: protectedSecret,
        stream: false,
      }),
    });
    expect(protectedResponse.status).toBe(200);
    const protectedBody = await protectedResponse.json() as {
      output?: Array<{ content?: Array<{ text?: unknown }> }>;
    };
    expect(protectedUpstreamInput).toBe("<STRIPE_ACCESS_TOKEN_1>");
    expect(protectedUpstreamInput).not.toContain(protectedSecret);
    expect(protectedBody.output?.[0]?.content?.[0]?.text).toBe(
      `protected ${protectedSecret}`,
    );

    const excludedResponse = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "excluded/test-model",
        input: excludedSecret,
        stream: false,
      }),
    });
    expect(excludedResponse.status).toBe(200);
    const excludedBody = await excludedResponse.json() as {
      output?: Array<{ content?: Array<{ text?: unknown }> }>;
    };
    expect(excludedUpstreamInput).toBe(excludedSecret);
    expect(excludedBody.output?.[0]?.content?.[0]?.text).toBe(
      "excluded <STRIPE_ACCESS_TOKEN_1>",
    );
  } finally {
    await proxy?.stop(true);
    protectedUpstream.stop(true);
    excludedUpstream.stop(true);
  }
});
