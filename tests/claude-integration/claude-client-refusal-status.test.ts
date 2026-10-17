import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { httpStatusFromTerminalError } from "../../src/lib/errors";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A 200 SSE that the upstream ends with a bare `error` frame declaring a client-class type
// (no refusal code). It used to be stamped `upstream_error` and answered as a retryable 502,
// so Claude Code retried a request the upstream had already refused.

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-refusal-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-refusal-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

async function send(
  errorType: string,
  stream: boolean,
  message = `upstream says ${errorType}`,
): Promise<{ status: number; calls: number; text: string }> {
  let calls = 0;
  const frames = 'data: {"type":"response.in_progress"}\n\n'
    + `data: ${JSON.stringify({ type: "error", error: { type: errorType, message } })}\n\n`;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return new Response(frames, { headers: { "content-type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "native",
    providers: {
      native: {
        adapter: "openai-responses",
        baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`,
        authMode: "forward",
        allowPrivateNetwork: true,
      },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "native/gpt-test", max_tokens: 64, stream, messages: [{ role: "user", content: "hi" }] }),
    });
    return { status: response.status, calls, text: await response.text() };
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
}

test.each([
  ["invalid_request_error", 400],
  ["authentication_error", 401],
  ["permission_error", 403],
  ["not_found_error", 404],
])("non-streaming: a declared %s answers %i, not a retryable 502", async (errorType, status) => {
  const result = await send(errorType, false);
  expect(result.status).toBe(status);
  expect(JSON.parse(result.text).error).toMatchObject({ type: errorType, message: `upstream says ${errorType}` });
  expect(result.calls).toBe(1);
}, 15_000);

test.each(["invalid_request_error", "permission_error"])(
  "streaming: a declared %s reaches the client as that type, not a retryable overload",
  async (errorType) => {
    const result = await send(errorType, true);
    expect(result.status).toBe(200);
    const data = JSON.parse(result.text.split("event: error\ndata: ")[1]!.split("\n")[0]!);
    expect(data.error.type).toBe(errorType);
  },
  15_000,
);

test("server-class overload keeps the 502 it had", async () => {
  const result = await send("overloaded_error", false);
  expect(result.status).toBe(502);
}, 15_000);

test("non-streaming: an invalid_request_error worded as a client close answers 499, as it is logged", async () => {
  const result = await send("invalid_request_error", false, "client closed request during web-search");
  expect(result.status).toBe(499);
  expect((await send("permission_error", false, "client closed request")).status).toBe(403);
}, 15_000);

test("a codeless invalid_request_error worded as a client close stays 499", () => {
  expect(httpStatusFromTerminalError({ type: "invalid_request_error", message: "client closed request" })).toBe(499);
  expect(httpStatusFromTerminalError({ type: "invalid_request_error", message: "bad shape" })).toBe(400);
  // Only the recognized 400 yields to client-closed wording; other classes keep their dev order.
  expect(httpStatusFromTerminalError({ type: "permission_error", message: "client closed request" })).toBe(403);
  expect(httpStatusFromTerminalError({ type: "rate_limit_error", message: "client closed request" })).toBe(429);
});
