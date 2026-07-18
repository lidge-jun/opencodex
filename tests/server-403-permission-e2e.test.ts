import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { classifyError } from "../src/lib/errors";
import { startServer } from "../src/server";
import { clearRequestLogsForTests } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const SUBSCRIPTION_MESSAGE =
  "this model requires a subscription, upgrade for access: https://ollama.com/upgrade";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-403-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-403-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearRequestLogsForTests();
});

afterEach(() => {
  clearRequestLogsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function config(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "ollama-test",
    providers: {
      "ollama-test": {
        adapter: "openai-chat",
        baseUrl,
        allowPrivateNetwork: true,
        authMode: "key",
        apiKey: "ollama-test-key",
        models: ["pro-model"],
        defaultModel: "pro-model",
      },
    },
  } as OcxConfig;
}

async function runUpstreamFailure(status: 401 | 403, body: unknown): Promise<{
  path: string;
  responseStatus: number;
  error: { message?: string; type?: string; code?: string | null };
  log: { status?: number; errorCode?: string; upstreamError?: string };
}> {
  let path = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      path = new URL(req.url).pathname;
      return Response.json(body, { status });
    },
  });
  saveConfig(config(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  const proxy = startServer(0);
  try {
    const response = await fetch(new URL("/v1/responses", proxy.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama-test/pro-model",
        input: "hello",
        stream: false,
      }),
    });
    const payload = await response.json() as {
      error: { message?: string; type?: string; code?: string | null };
    };
    const logs = await fetch(new URL("/api/logs?tail=1", proxy.url)).then(res => res.json()) as Array<{
      status?: number;
      errorCode?: string;
      upstreamError?: string;
    }>;
    return {
      path,
      responseStatus: response.status,
      error: payload.error,
      log: logs[0] ?? {},
    };
  } finally {
    await proxy.stop(true);
    await upstream.stop(true);
  }
}

describe("upstream 401/403 classification (end-to-end)", () => {
  test("Ollama string error body becomes subscription_required through HTTP, adapter, classifier, and log", async () => {
    const result = await runUpstreamFailure(403, { error: SUBSCRIPTION_MESSAGE });

    expect(result.path).toBe("/v1/chat/completions");
    expect(result.responseStatus).toBe(403);
    expect(result.error).toMatchObject({
      type: "permission_error",
      code: "subscription_required",
    });
    expect(result.error.message).toContain(SUBSCRIPTION_MESSAGE);
    expect(result.log).toMatchObject({
      status: 403,
      errorCode: "subscription_required",
    });
    expect(result.log.upstreamError).toContain(SUBSCRIPTION_MESSAGE);
  });

  test("the same subscription body under authoritative 401 stays invalid_api_key", async () => {
    const result = await runUpstreamFailure(401, { error: SUBSCRIPTION_MESSAGE });

    expect(result.path).toBe("/v1/chat/completions");
    expect(result.responseStatus).toBe(401);
    expect(result.error).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
    expect(result.log).toMatchObject({
      status: 401,
      errorCode: "invalid_api_key",
    });
  });

  test("bare Provider error 403 remains permission_denied", () => {
    expect(classifyError(403, "upstream_error", "Provider error 403")).toMatchObject({
      type: "permission_error",
      code: "permission_denied",
    });
  });
});
