import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { decodeCompactionSummary, encodeCompactionSummary } from "../../src/responses/compaction";
import { decodeRetainedCompaction, encodeRetainedCompaction } from "../../src/responses/retained-compaction";
import { prepareCompactionRetention } from "../../src/server/responses/compaction-retention";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { parseRequest } from "../../src/responses/parser";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { compactionRequest, completedPayload, drainCompactionResponseState,
  installCompactionRoutingAclFixture, jsonResponse, keyProviderConfig,
  removeCompactionFixture, sseResponse } from "../helpers/compaction-routing-fixtures";

const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let home: string;
let releaseSpendHome: () => void;
installCompactionRoutingAclFixture();
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-retention-v2-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  try { await drainCompactionResponseState(); } finally {
    releaseSpendHome();
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
const original = "  excluded option A because of compatibility\n保留原文  ";
const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: original }], encrypted_content: "opaque-private-signature" };
const body = (stream = false, input: unknown[] = [reasoning]) => ({ model: "gw/some-model", stream,
  input: [{ type: "message", role: "user", content: "fix addition" }, ...input, { type: "compaction_trigger" }] });
async function result(response: Response): Promise<Record<string, any>> {
  expect(response.status).toBe(200);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json() as Record<string, any>;
  const text = await response.text();
  const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const completed = events.find(event => event.type === "response.completed");
  expect(completed).toBeDefined();
  expect(events.filter(event => event.type === "response.output_item.done")).toHaveLength(1);
  return completed.response;
}
function archives(): string[] {
  const dir = join(home, "reasoning-archive");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("routed v2 retention", () => {
  test.each([false, true])("exact reasoning survives compaction, replay and repeated compaction (stream=%s)", async stream => {
    let sent = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).text();
      return stream ? sseResponse([
        { type: "response.output_text.delta", delta: "current progress" },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ]) : jsonResponse(completedPayload("current progress"));
    }) as typeof fetch;
    const config = keyProviderConfig();
    const first = await result(await handleResponses(compactionRequest(body(stream)), config, { model: "", provider: "" }));
    expect(first.output).toHaveLength(1);
    expect(first.output[0].type).toBe("compaction");
    expect(sent).not.toContain("excluded option A");
    expect(sent).not.toContain("opaque-private-signature");
    const data = decodeRetainedCompaction(first.output[0].encrypted_content)!;
    expect(data.summary).toBe("current progress");
    expect(data.reasoning).toHaveLength(1);
    expect(data.reasoning[0]).toContain(original);
    const parsed = parseRequest({ model: "gw/some-model", input: first.output });
    expect(parsed.context.messages).toHaveLength(2);
    expect(parsed.context.messages[1].content).toBe(data.reasoning[0]);
    const second = await result(await handleResponses(compactionRequest(body(stream, first.output)), config, { model: "", provider: "" }));
    expect(decodeRetainedCompaction(second.output[0].encrypted_content)?.reasoning).toEqual(data.reasoning);
    expect(sent).not.toContain("excluded option A");
    // The raw Responses adapter must lower the envelope before an ordinary turn too.
    await (await handleResponses(compactionRequest({ model: "gw/some-model", stream,
      input: [...second.output, { type: "message", role: "user", content: "continue" }] }), config, { model: "", provider: "" })).text();
    expect(sent).toContain("excluded option A");
    expect(sent).not.toContain("ocx2:");
  });

  test("canonical native v2 retains its original protocol and creates no local archive", async () => {
    const config = keyProviderConfig({ authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" });
    config.reasoningRetention = { maxTokens: 1 };
    let sent = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).text();
      expect(archives()).toEqual([]);
      return sseResponse([{ type: "response.completed", response: {
        status: "completed", output: [{ type: "compaction", encrypted_content: "native-ciphertext" }],
      } }]);
    }) as typeof fetch;
    const response = await handleResponses(compactionRequest(body(true), undefined, {
      authorization: "Bearer native-fixture-only", "chatgpt-account-id": "native-fixture-account",
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(sent).toContain("excluded option A");
    expect(sent).toContain("compaction_trigger");
    expect(text).toContain("native-ciphertext");
    expect(text).not.toContain("ocx2:");
    expect(archives()).toEqual([]);
  });

  test("v1 can compact a v2 retained envelope without summarizing its reasoning", async () => {
    let sent = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = await new Request(url, init).text();
      return jsonResponse(completedPayload("progress"));
    }) as typeof fetch;
    const config = keyProviderConfig();
    const first = await result(await handleResponses(compactionRequest(body()), config, { model: "", provider: "" }));
    const compact = await handleResponsesCompact(compactionRequest({ model: "gw/some-model", input: first.output }), config, { model: "", provider: "" });
    const next = await compact.json() as { output: unknown[] };
    expect(compact.status).toBe(200);
    expect(JSON.stringify(next.output)).toContain("excluded option A");
    expect(sent).not.toContain("excluded option A");
  });

  test("overflow archives exact text and publishes the path in the single envelope", async () => {
    globalThis.fetch = (async () => jsonResponse(completedPayload("progress"))) as typeof fetch;
    const config = keyProviderConfig();
    config.reasoningRetention = { maxTokens: 1 };
    const json = await result(await handleResponses(compactionRequest(body()), config, { model: "", provider: "" }));
    const data = decodeRetainedCompaction(json.output[0].encrypted_content)!;
    expect(data.reasoning).toEqual([]);
    expect(archives()).toHaveLength(1);
    const path = join(home, "reasoning-archive", archives()[0]!);
    expect(readFileSync(path, "utf-8")).toBe(original);
    expect(data.summary).toContain(path);
  });

  test.each([false, true].flatMap(stream => ["failed", "incomplete", "empty", "opaque", "http-error", "cancelled"].map(outcome => [stream, outcome] as const)))("stream=%s %s does not retain a provisional archive", async (stream, outcome) => {
    const config = keyProviderConfig();
    config.reasoningRetention = { maxTokens: 1 };
    const abort = new AbortController();
    globalThis.fetch = (async () => {
      expect(archives()).toHaveLength(1);
      if (outcome === "cancelled") { abort.abort(); throw abort.signal.reason; }
      if (outcome === "http-error") return new Response("bad request", { status: 400 });
      if (outcome === "opaque") {
        const payload = { status: "completed", output: [{ type: "compaction", encrypted_content: "native-ciphertext" }] };
        return stream ? sseResponse([{ type: "response.completed", response: payload }]) : jsonResponse(payload);
      }
      if (outcome === "empty") return jsonResponse(completedPayload(""));
      return jsonResponse({ ...completedPayload("partial"), status: outcome });
    }) as typeof fetch;
    try {
      const response = await handleResponses(compactionRequest(body(stream), abort.signal), config, { model: "", provider: "" });
      const text = await response.text();
      if (outcome === "empty") {
        expect(text).not.toContain("ocx2:");
        if (response.status === 200) {
          if (stream) expect(text).toContain("response.failed");
          else expect(JSON.parse(text).status).toBe("failed");
        }
        else { expect(response.status).toBe(502); expect(text).toContain("invalid_compaction_summary"); }
      }
      if (outcome === "opaque") { expect(text).toContain("native-ciphertext"); expect(text).not.toContain("ocx2:"); }
    } catch (error) { if (outcome !== "cancelled") throw error; }
    expect(archives()).toEqual([]);
  });

  test("body cancellation cleans up before a stalled upstream cancel settles", () => {
    const config = keyProviderConfig();
    config.reasoningRetention = { maxTokens: 1 };
    const parsed = parseRequest(body(true));
    const budget = createTranslatorBudget();
    const retention = prepareCompactionRetention(parsed, config, undefined, budget, new AbortController().signal)!;
    expect(archives()).toHaveLength(1);
    const response = retention.deliver(new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) })));
    void response.body!.cancel();
    expect(archives()).toEqual([]);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("same-target retries reuse one provisional archive", async () => {
    const config = keyProviderConfig({ retryOn429: { attempts: 1, intervalMs: 1, maxIntervalMs: 1 } });
    config.reasoningRetention = { maxTokens: 1 };
    const files: string[][] = [];
    globalThis.fetch = (async () => {
      files.push(archives());
      return files.length === 1 ? new Response("rate limited", { status: 429 }) : jsonResponse(completedPayload("progress"));
    }) as typeof fetch;
    await result(await handleResponses(compactionRequest(body()), config, { model: "", provider: "" }));
    expect(files).toHaveLength(2);
    expect(files[0]).toHaveLength(1);
    expect(files[1]).toEqual(files[0]);
    expect(archives()).toEqual(files[0]);
  });
});

describe("retained compaction encoding", () => {
  test("old envelopes and generic history recovery remain readable", () => {
    expect(decodeCompactionSummary(encodeCompactionSummary("old summary"))).toBe("old summary");
    expect(decodeCompactionSummary(encodeRetainedCompaction("summary", [original]))).toContain(original);
    expect(decodeCompactionSummary("native-ciphertext")).toBeNull();
  });
  test.each(["not-base64", Buffer.from('{"version":3,"summary":"x","reasoning":[]}').toString("base64"),
    Buffer.from('{"version":2,"summary":"x","reasoning":[123]}').toString("base64")])("malformed proxy envelopes fail explicitly (%s)", payload => {
    expect(() => parseRequest({ model: "gw/some-model", input: [{ type: "compaction", encrypted_content: "ocx2:" + payload }] })).toThrow();
  });
});
