import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getRequestLogEntries } from "../../src/server/request-log";
import { OLLAMA_MAX_RETRY_AFTER_SECONDS, ollamaRetryAfter, toOllamaRefusal } from "../../src/server/ollama-inbound";
import { workflowDenialSummary, type WorkflowDenial } from "../../src/lib/workflow-budget";
import { workflowRefusalResponse } from "../../src/server/workflow-refusal";
import type { OcxConfig } from "../../src/types";
import { usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A provider key with no recognizable prefix: pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
// All digits, so a Retry-After parser accepts it as a delay in seconds.
const NUMERIC_KEY = "73915028461739205817";
const saved = process.env.OPENCODEX_HOME;
let home = "";
let mode: "status400" | "status401" | "status500" | "frame" | "retryAfter429" | "retryAfter400" = "status400";
let upstream: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ollama-errors-"));
  process.env.OPENCODEX_HOME = home;
  upstream = Bun.serve({ port: 0, async fetch(req) {
    await req.json();
    // The upstream echoes the credential it received, as some gateways do in error text.
    const echoed = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const error = { message: "invalid key " + echoed, type: "invalid_request_error", code: echoed, param: echoed };
    if (mode === "frame") {
      const frames = [
        "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }] }) + "\n\n",
        "data: " + JSON.stringify({ error }) + "\n\n",
      ];
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (mode === "retryAfter429" || mode === "retryAfter400") {
      return Response.json({ error: { message: "slow down" } }, { status: mode === "retryAfter429" ? 429 : 400, headers: { "retry-after": echoed } });
    }
    const status = mode === "status401" ? 401 : mode === "status500" ? 500 : 400;
    return Response.json({ error }, { status, headers: { "x-upstream-echo": echoed } });
  } });
});
afterAll(() => {
  upstream.stop(true);
  if (saved === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved;
  if (home) removeTreeWithRetry(home);
});
function saveProvider(apiKey: string) {
  saveConfig({
    port: 0, defaultProvider: "fx",
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey, allowPrivateNetwork: true, models: ["m1"] } },
  } as unknown as OcxConfig);
}
beforeEach(() => saveProvider(PROVIDER_KEY));

async function exchange(path: string, body: Record<string, unknown>) {
  const server = startServer(0);
  const earlier = new Set(getRequestLogEntries().map(entry => entry.requestId));
  try {
    const res = await fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    const headers = JSON.stringify([...res.headers.entries()]);
    await Bun.sleep(150);
    const rows = getRequestLogEntries().filter(entry => !earlier.has(entry.requestId));
    return { status: res.status, text, headers, rows };
  } finally { await server.stop(true); }
}

describe("Ollama error bodies never carry upstream text", () => {
  for (const path of ["/api/chat", "/api/generate"] as const) {
    for (const stream of [false, true]) {
      const request = (path === "/api/chat"
        ? { model: "fx/m1", messages: [{ role: "user", content: "hi" }], stream }
        : { model: "fx/m1", prompt: "hi", stream });
      for (const [errorMode, status, message] of [["status400", 400, "request rejected"], ["status401", 401, "upstream authentication failed"], ["status500", 500, "upstream request failed"]] as const) {
        test(path + " stream=" + stream + " upstream " + status + " echoing the provider key", async () => {
          mode = errorMode;
          const result = await exchange(path, request);
          expect(result.status).toBe(status);
          expect(JSON.parse(result.text)).toEqual({ error: message });
          expect(result.text).not.toContain(PROVIDER_KEY);
          expect(result.headers).not.toContain(PROVIDER_KEY);
          expect(result.rows).toHaveLength(1);
          expect(JSON.stringify(result.rows)).not.toContain(PROVIDER_KEY);
          expect(existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8") : "").not.toContain(PROVIDER_KEY);
        });
      }
    }
    test(path + " streamed error frame echoing the provider key ends with a fixed native error", async () => {
      mode = "frame";
      const request = path === "/api/chat" ? { model: "fx/m1", messages: [{ role: "user", content: "hi" }] } : { model: "fx/m1", prompt: "hi" };
      const result = await exchange(path, request);
      expect(result.text).not.toContain(PROVIDER_KEY);
      expect(result.headers).not.toContain(PROVIDER_KEY);
      const lines = result.text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      expect(lines.some(line => line.done === true)).toBe(false);
      expect(lines.at(-1)).toEqual({ error: "upstream stream failed" });
      expect(JSON.stringify(result.rows)).not.toContain(PROVIDER_KEY);
      expect(existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8") : "").not.toContain(PROVIDER_KEY);
    });
  }
});

describe("Ollama responses never copy upstream header bytes", () => {
  for (const path of ["/api/chat", "/api/generate"] as const) {
    for (const stream of [false, true]) {
      for (const [retryMode, status] of [["retryAfter429", 429], ["retryAfter400", 400]] as const) {
        test(path + " stream=" + stream + " upstream " + status + " with a numeric key in Retry-After", async () => {
          mode = retryMode;
          saveProvider(NUMERIC_KEY);
          const request = path === "/api/chat"
            ? { model: "fx/m1", messages: [{ role: "user", content: "hi" }], stream }
            : { model: "fx/m1", prompt: "hi", stream };
          const result = await exchange(path, request);
          expect(result.status).toBe(status);
          expect(result.text).not.toContain(NUMERIC_KEY);
          expect(result.headers).not.toContain(NUMERIC_KEY);
          // The advice survives only as an integer we formatted, clamped to the surface's bound.
          const retryAfter = (JSON.parse(result.headers) as [string, string][]).find(([name]) => name === "retry-after")?.[1];
          expect(retryAfter).toMatch(/^[0-9]{1,4}$/);
          expect(Number(retryAfter)).toBeLessThanOrEqual(OLLAMA_MAX_RETRY_AFTER_SECONDS);
          expect(JSON.stringify(result.rows)).not.toContain(NUMERIC_KEY);
          expect(existsSync(usageLogPath()) ? readFileSync(usageLogPath(), "utf8") : "").not.toContain(NUMERIC_KEY);
        });
      }
    }
  }

  test("retry advice is reformatted, clamped, or dropped; never echoed", () => {
    expect(ollamaRetryAfter("0")).toBe("0");
    expect(ollamaRetryAfter("7")).toBe("7");
    expect(ollamaRetryAfter("1.2")).toBe("2");
    expect(ollamaRetryAfter(" 07 ")).toBe("7");
    expect(Number(ollamaRetryAfter(NUMERIC_KEY))).toBeLessThanOrEqual(OLLAMA_MAX_RETRY_AFTER_SECONDS);
    expect(ollamaRetryAfter(NUMERIC_KEY)).not.toBe(NUMERIC_KEY);
    expect(ollamaRetryAfter(PROVIDER_KEY)).toBeUndefined();
    expect(ollamaRetryAfter(null)).toBeUndefined();
    const now = Date.UTC(2026, 0, 1);
    expect(ollamaRetryAfter(new Date(now + 90_000).toUTCString(), now)).toBe("90");
  });

  test("a refusal keeps only headers this surface generates", () => {
    const refusal = new Response("{}", { status: 429, headers: {
      "retry-after": NUMERIC_KEY, "x-opencodex-local-refusal": "workflow_sends_exhausted",
      "x-upstream-echo": PROVIDER_KEY, "set-cookie": "a=" + PROVIDER_KEY,
    } });
    const native = toOllamaRefusal(refusal);
    expect([...native.headers.keys()].sort()).toEqual(["access-control-expose-headers", "content-type", "retry-after", "x-opencodex-local-refusal"]);
    expect(Number(native.headers.get("retry-after"))).toBeLessThanOrEqual(OLLAMA_MAX_RETRY_AFTER_SECONDS);
    // Values that are not a recognized local code never cross, whatever their shape.
    for (const forged of [NUMERIC_KEY, PROVIDER_KEY, "workflow-sends-exhausted", "WORKFLOW_SENDS_EXHAUSTED", "constructor"]) {
      const odd = toOllamaRefusal(new Response("{}", { status: 429, headers: { "x-opencodex-local-refusal": forged } }));
      expect({ forged, headers: [...odd.headers.keys()] }).toEqual({ forged, headers: ["content-type"] });
    }
  });

  test("every real local refusal code maps to this surface's own constant", () => {
    const reasons: WorkflowDenial[] = ["workflow-concurrency-exhausted", "workflow-sends-exhausted", "workflow-children-exhausted",
      "workflow-spend-exhausted", "workflow-tracking-exhausted", "workflow-send-replayed", "workflow-spend-undurable", "workflow-pool-history-unresolved"];
    for (const reason of reasons) {
      const produced = workflowRefusalResponse(reason);
      const expected = workflowDenialSummary(reason).code;
      expect(produced.headers.get("x-opencodex-local-refusal")).toBe(expected);
      const native = toOllamaRefusal(produced);
      expect({ reason, status: native.status, code: native.headers.get("x-opencodex-local-refusal") }).toEqual({ reason, status: 429, code: expected });
      expect(native.headers.get("access-control-expose-headers")).toBe("x-opencodex-local-refusal");
    }
  });
});
