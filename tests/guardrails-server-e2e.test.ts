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
