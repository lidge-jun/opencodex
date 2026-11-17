import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { DEVELOPER_ROLE_REFUSAL_MESSAGE } from "../../src/lib/client-error-body";
import { upstreamConditionMessage } from "../../src/lib/upstream-condition";
import { startServer } from "../../src/server";
import { getRequestLogEntries, requestLogEntryFromPersistedUsage } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { readUsageEntries, usageLogPath } from "../../src/usage/log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8864 end to end on native /v1/chat/completions: a provider that rejects the developer role is named to the
// client and in the live row, usage.jsonl and hydration through proxy-owned facts only.
const DASHSCOPE = "developer is not one of ['system','assistant','user','tool','function']";
const UNRELATED = "Invalid value for 'temperature': must be between 0 and 2";
const saved = { home: process.env.OPENCODEX_HOME };
let home = "";
let upstreamMessage = DASHSCOPE;
let upstream: ReturnType<typeof Bun.serve>;
let releaseSpendHome: (() => void) | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-developer-role-"));
  process.env.OPENCODEX_HOME = home;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.text();
    if (new URL(req.url).pathname.endsWith("/messages")) {
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: upstreamMessage } }, { status: 400 });
    }
    return Response.json({ error: { message: upstreamMessage, type: "invalid_request_error", param: null, code: "invalid_request_error" } }, { status: 400 });
  } });
  releaseSpendHome = acquireOwnedSpendHome();
  saveConfig({
    port: 0, defaultProvider: "dsx",
    providers: {
      dsx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: "test-key", allowPrivateNetwork: true, models: ["m1"] },
      dsa: { adapter: "anthropic", baseUrl: upstream.url.origin, authMode: "key", apiKey: "test-key", allowPrivateNetwork: true, models: ["claude-x"] },
    },
  } as unknown as OcxConfig);
});
afterAll(() => {
  upstream.stop(true);
  releaseSpendHome?.();
  if (saved.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved.home;
  if (home) removeTreeWithRetry(home);
});

async function exchange(stream: boolean, path = "/v1/chat/completions", body?: Record<string, unknown>) {
  const printed: string[] = [];
  const originals = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  // Objects are printed with their nested fields, so provider text inside a logged object is still caught.
  for (const name of ["warn", "error", "log", "info"] as const) console[name] = (...args: unknown[]) => {
    printed.push(args.map(arg => typeof arg === "string" ? arg : Bun.inspect(arg, { depth: Infinity })).join(" "));
  };
  let server: ReturnType<typeof startServer> | undefined;
  try {
    server = startServer(0);
    const earlier = new Set(getRequestLogEntries().map(entry => entry.requestId));
    const before = existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8").length : 0;
    const res = await fetch(new URL(path, server.url), {
      method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body ?? { model: "dsx/m1", stream, messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }] }),
    });
    const text = await res.text();
    const deadline = Date.now() + 5_000;
    let rows = getRequestLogEntries().filter(entry => !earlier.has(entry.requestId));
    while (rows.length === 0 || !rows.every(row => readUsageEntries().some(entry => entry.requestId === row.requestId))) {
      if (Date.now() > deadline) throw new Error("no persisted request-log row within 5s");
      await Bun.sleep(20);
      rows = getRequestLogEntries().filter(entry => !earlier.has(entry.requestId));
    }
    const persisted = readFileSync(usageLogPath(), "utf8").slice(before);
    return { status: res.status, text, rows, persisted, printed: printed.join("\n") };
  } finally {
    try { await server?.stop(true); } finally { Object.assign(console, originals); }
  }
}

function clientMessage(text: string): string {
  const json = text.trim().startsWith("data:") ? text.trim().split("\n").find(line => line.startsWith("data: {"))!.slice(6) : text;
  return (JSON.parse(json) as { error: { message: string } }).error.message;
}

describe("developer-role rejection at the client boundary", () => {
  for (const stream of [false, true]) {
    test("stream=" + stream + " names the cause to the client and in the request log", async () => {
      upstreamMessage = DASHSCOPE;
      const result = await exchange(stream);
      expect(result.status).toBe(400);
      expect(clientMessage(result.text)).toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
      const pair = [{ field: "messages.role", type: "enum" }];
      expect(result.rows[0]!.failureDetail?.validation).toEqual(pair);
      const disk = readUsageEntries().find(entry => entry.requestId === result.rows[0]!.requestId)!;
      expect(disk.failureDetail?.validation).toEqual(pair);
      expect(requestLogEntryFromPersistedUsage(disk).failureDetail?.validation).toEqual(pair);
      for (const recorded of [result.text, JSON.stringify(result.rows), result.persisted, result.printed]) {
        expect(recorded).not.toContain("is not one of");
      }
    });
  }

  test("a Messages client gets the same sentence without the provider text", async () => {
    upstreamMessage = DASHSCOPE;
    const result = await exchange(false, "/v1/messages", { model: "dsa/claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(result.status).toBe(400);
    expect(clientMessage(result.text)).toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
    for (const recorded of [result.text, JSON.stringify(result.rows), result.persisted, result.printed]) {
      expect(recorded).not.toContain("is not one of");
    }
  });

  test("an unrelated 400 keeps the generic sentence and records no pair", async () => {
    upstreamMessage = UNRELATED;
    const result = await exchange(false);
    expect(result.status).toBe(400);
    expect(clientMessage(result.text)).toBe(upstreamConditionMessage("request_rejected"));
    expect(result.rows[0]!.failureDetail?.validation).toBeUndefined();
    expect(result.persisted).not.toContain("temperature");
  });
});
