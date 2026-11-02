import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { usageLogPath } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// A provider key with no recognizable prefix: pattern-based redaction cannot spot it.
const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const saved = process.env.OPENCODEX_HOME;
let home = "";
let mode: "status400" | "status401" | "status500" | "frame" = "status400";
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
    const status = mode === "status401" ? 401 : mode === "status500" ? 500 : 400;
    return Response.json({ error }, { status, headers: { "x-upstream-echo": echoed } });
  } });
});
afterAll(() => {
  upstream.stop(true);
  if (saved === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved;
  if (home) removeTreeWithRetry(home);
});
beforeEach(() => {
  saveConfig({
    port: 0, defaultProvider: "fx",
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"] } },
  } as unknown as OcxConfig);
});

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
