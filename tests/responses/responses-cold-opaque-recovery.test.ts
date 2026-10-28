import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSelfIdentifiedOpaqueBlobRejection } from "../../src/server/responses/core-opaque-recovery";
import { handleResponses } from "../../src/server/responses";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
let previousHome: string | undefined;
let home: string;
let release: () => void;
const blob = "fixture-native-ciphertext";
const error = { type: "invalid_request_error", code: "invalid_encrypted_content", message: "The encrypted content could not be verified." };
const cfg = { defaultProvider: "relay", providers: { relay: { adapter: "openai-responses", baseUrl: "https://relay.example.test/v1", authMode: "key", apiKey: "fixture-key", decodesNativeCompactionBlobs: true } } } as OcxConfig;
const input = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "remember fixture" }] },
  { type: "reasoning", summary: [], encrypted_content: blob },
  { type: "function_call", call_id: "fixture-call", name: "lookup", arguments: "{}" },
  { type: "function_call_output", call_id: "fixture-call", output: "fixture-result" },
  { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
];
const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const success = () => new Response(frame("response.completed", { response: { id: "fixture-ok", status: "completed", output: [] } }), { headers: { "content-type": "text/event-stream" } });
const rejected = () => new Response(frame("response.failed", { response: { id: "fixture-error", status: "failed", error } }), { headers: { "content-type": "text/event-stream" } });

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-cold-opaque-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearReasoningReplayCacheForTests();
  release();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function send() {
  const body = JSON.stringify({ model: "relay/model-a", stream: true, store: false, input });
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body });
  const response = await handleResponses(req, cfg, { model: "", provider: "" });
  const text = await response.text();
  expect(JSON.stringify(input)).toContain(blob);
  return text;
}

for (const shape of ["sse", "flat-code", "flat-wording", "502"] as const) test(`cold reasoning rejection ${shape} rebuilds once and preserves tool pairs (#7369)`, async () => {
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    if (sent.length <= (shape === "502" ? 3 : 1)) {
      if (shape === "502") return Response.json({ error }, { status: 502 });
      if (shape === "sse") return rejected();
      const flat = shape === "flat-code" ? { code: error.code, message: error.message } : {
        message: "The encrypted content fixture could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
      };
      return new Response(frame("error", flat), { headers: { "content-type": "text/event-stream" } });
    }
    return success();
  }) as typeof fetch;
  const text = await send();
  expect(text).toContain("response.completed");
  expect(sent).toHaveLength(shape === "502" ? 4 : 2);
  expect(sent.every(body => body.store === false)).toBe(true);
  expect(JSON.stringify(sent[0])).toContain(blob);
  expect(JSON.stringify(sent.at(-1))).not.toContain(blob);
  const items = sent.at(-1)!.input as Array<Record<string, unknown>>;
  expect(items.filter(x => x.call_id === "fixture-call").map(x => x.type)).toEqual(["function_call", "function_call_output"]);
  expect(items.find(x => x.type === "function_call_output")?.output).toBe("fixture-result");
});

test("cold valid native replay is preserved without another send", async () => {
  let sends = 0;
  globalThis.fetch = (async (_url, init) => { sends++; expect(String(init?.body)).toContain(blob); return success(); }) as typeof fetch;
  expect(await send()).toContain("response.completed");
  expect(sends).toBe(1);
});

test("repeated explicit rejection is terminal after one rebuild", async () => {
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return rejected(); }) as typeof fetch;
  expect(await send()).not.toContain("response.completed");
  expect(sends).toBe(2);
});

test("generic 502 does not authorize opaque recovery", async () => {
  let sends = 0;
  globalThis.fetch = (async () => { sends++; return Response.json({ error: { type: "server_error", message: "gateway unavailable" } }, { status: 502 }); }) as typeof fetch;
  await send();
  expect(sends).toBe(3); // Existing generic pre-header transient retries remain unchanged.
});

test.each(["text", "tool"])("a rejection after committed %s cannot resend the turn", async kind => {
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return new Response((kind === "text" ? frame("response.output_text.delta", { delta: "visible text", item_id: "fixture-text", output_index: 0, content_index: 0 }) : frame("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fixture-tool", call_id: "fixture-tool-call", name: "lookup", arguments: "{}" } })) + frame("response.failed", { response: { status: "failed", error } }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  await send();
  expect(sends).toBe(1);
});

test("a competing nested failure cannot borrow a flat ciphertext code", () => {
  expect(isSelfIdentifiedOpaqueBlobRejection(JSON.stringify({ type: "error", code: "invalid_encrypted_content",
    message: "The encrypted content could not be verified.", error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "quota" } }))).toBe(false);
});
