import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let proxy: ReturnType<typeof startServer> | undefined;
let calls = 0;
let upstreamResponse: () => Response;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-529-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-529-"));
  process.env.OPENCODEX_HOME = testDir;
  calls = 0;
  upstreamResponse = () => Response.json({ error: { message: "bad request shape" } }, { status: 400 });
  upstream = Bun.serve({ port: 0, fetch() { calls++; return upstreamResponse(); } });
  saveConfig(nativeConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`));
  proxy = startServer(0);
}, 10_000);

afterEach(async () => {
  const codexHome = isolatedCodexHome;
  isolatedCodexHome = null;
  try {
    try { await proxy?.stop(true); }
    finally {
      proxy = undefined;
      await upstream?.stop(true);
      upstream = undefined;
    }
    if (testDir) await removeTreeAfterBackgroundWork(testDir);
    testDir = "";
  } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codexHome?.restoreEnvironment();
  }
  // A failed drain leaves the owned tree for the wrapper; never delete under its writer.
  codexHome?.removeAfterDrain();
}, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

function nativeConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    clientIntegrations: { codex: false },
    defaultProvider: "native",
    providers: {
      native: { adapter: "openai-responses", baseUrl, authMode: "forward", allowPrivateNetwork: true },
    },
  } as OcxConfig;
}

function messagesBody(): string {
  return JSON.stringify({
    model: "native/gpt-test",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
}

test("transient upstream 502 -> client 529 overloaded_error; retry fired; log keeps upstream 502", async () => {
  upstreamResponse = () => Response.json(
    { error: { message: "An error occurred while processing your request. request ID test-42" } },
    // Retry-After: 0 keeps the pre-stream retry backoff instant AND must win over the "2" fallback.
    { status: 502, headers: { "Retry-After": "0" } },
  );
  const response = await fetch(new URL("/v1/messages", proxy!.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: messagesBody(),
  });
  // Pre-stream transient retry (010) exhausts its attempts against the persistent 502 …
  expect(calls).toBe(3);
  // … then the Claude envelope reclassifies the transient 5xx as retryable overload (020).
  expect(response.status).toBe(529);
  expect(response.headers.get("retry-after")).toBe("0");
  const json = await response.json() as { type?: string; error?: { type?: string; message?: string } };
  expect(json.error?.type).toBe("overloaded_error");
  expect(json.error?.message).toBe("The provider failed to complete the request.");
  // Diagnostics stay honest: the request log keeps the upstream status, not the client 529.
  const entry = getRequestLogEntries().findLast(e => e.surface === "claude");
  expect(entry?.status).toBe(502);
}, 15_000);

test("transient 502 without Retry-After -> fallback Retry-After 2 on the 529 response", async () => {
  upstreamResponse = () => Response.json({ error: { message: "boom" } }, { status: 502 });
  const response = await fetch(new URL("/v1/messages", proxy!.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: messagesBody(),
  });
  expect(response.status).toBe(529);
  expect(response.headers.get("retry-after")).toBe("2");
}, 15_000);

test("non-transient upstream 400 stays 400 invalid_request_error; no retry", async () => {
  const response = await fetch(new URL("/v1/messages", proxy!.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: messagesBody(),
  });
  expect(calls).toBe(1);
  expect(response.status).toBe(400);
  const json = await response.json() as { error?: { type?: string } };
  expect(json.error?.type).toBe("invalid_request_error");
});
