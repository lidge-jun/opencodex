import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponsesCompact } from "../../src/server/responses";
import { clearCompactHandoffRoutesForTests } from "../../src/server/responses/compact";
import { getDefaultConfig } from "../../src/config";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../../src/responses/compaction";
import { encodeRetainedCompaction } from "../../src/responses/retained-compaction";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// #8042: canonical and official native v1 compact forwarded OpenCodex's own `ocx1:`/`ocx2:`
// envelopes verbatim, and the upstream refused them as invalid_encrypted_content. Only the custom
// gateway send lowered them; ordinary turns always do.
const fetchBefore = globalThis.fetch; const homeBefore = process.env.OPENCODEX_HOME;
let home: string; let release: (() => void) | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-native-compact-ocx-envelope-")); process.env.OPENCODEX_HOME = home; release = acquireOwnedSpendHome(); clearCompactHandoffRoutesForTests(); });
afterEach(() => { globalThis.fetch = fetchBefore; release?.(); clearCompactHandoffRoutesForTests(); if (homeBefore === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = homeBefore; removeTreeWithRetry(home); });

const NATIVE_BLOB = "gAAAAABnative-opaque-compaction-blob==";
const nativeItem = () => ({ type: "compaction", encrypted_content: NATIVE_BLOB });
const input = () => [
  { type: "message", role: "user", content: [{ type: "input_text", text: "retain ordinary history" }] },
  { type: "compaction", encrypted_content: encodeCompactionSummary("routed ocx1 summary") },
  { type: "compaction_summary", encrypted_content: encodeRetainedCompaction("retained ocx2 summary", ["retained reasoning context"]) },
  nativeItem(),
];

async function compact(api: boolean) {
  const settings = getDefaultConfig(); delete settings.compactionRouting; settings.defaultProvider = "openai"; settings.providers = {
    openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" },
    "openai-apikey": { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://api.openai.com/v1" },
  };
  const raw = { model: api ? "openai-apikey/gpt-6-luna" : "gpt-6-luna", input: input() };
  const snapshot = JSON.stringify(raw);
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return Response.json({ output: [{ type: "compaction", encrypted_content: "official-compact-opaque" }] });
  }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json", "thread-id": "fixture-thread", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "fixture-account" })}` }, body: JSON.stringify(raw) });
  const response = await handleResponsesCompact(req, settings, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(JSON.stringify(raw)).toBe(snapshot);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

test.each([
  ["canonical ChatGPT", false, "https://chatgpt.com/backend-api/codex/responses/compact"],
  ["official OpenAI API", true, "https://api.openai.com/v1/responses/compact"],
] as const)("%s native v1 compact lowers ocx envelopes and keeps native blobs byte-identical", async (_label, api, url) => {
  const call = await compact(api);
  expect(call.url).toBe(url);
  expect(call.body).not.toContain("ocx1:");
  expect(call.body).not.toContain("ocx2:");
  expect(call.body).toContain(JSON.stringify(nativeItem()));
  const body = JSON.parse(call.body) as { input: Record<string, unknown>[] };
  expect(body.input).toEqual([
    input()[0]!,
    { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nrouted ocx1 summary` }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\nretained ocx2 summary` }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "retained reasoning context" }] },
    nativeItem(),
  ]);
});
