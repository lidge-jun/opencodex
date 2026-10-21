import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, compactionRequest, completedPayload, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";

const blobA = { type: "compaction", encrypted_content: "provenance-blob-a-fixture" };
const blobB = { type: "compaction", encrypted_content: "provenance-blob-b-fixture" };
const message = { type: "message", role: "user", content: [{ type: "input_text", text: "Retained replacement summary fixture." }] };
const failed = { status: "failed", output: [], error: { message: "Gateway compaction failed fixture" } };
const rows = [
  { label: "failed 200", payload: failed, commits: false },
  { label: "failed with blob", payload: { ...failed, output: [blobB] }, commits: false },
  { label: "completed with error", payload: { ...failed, status: "completed", output: [blobB] }, commits: false },
  { label: "error without status", payload: { output: [blobB], error: { message: "Compaction error fixture" } }, commits: false },
  { label: "malformed error", payload: { status: "completed", output: [blobB], error: "failure fixture" }, commits: false },
  { label: "incomplete", payload: { status: "incomplete", output: [blobB] }, commits: false },
  { label: "unknown status", payload: { status: "success", output: [blobB] }, commits: false },
  { label: "null status", payload: { status: null, output: [blobB] }, commits: false },
  { label: "empty completed", payload: { status: "completed", output: [] }, commits: false },
  { label: "missing output", payload: { status: "completed" }, commits: false },
  { label: "nonarray output", payload: { output: blobB }, commits: false },
  { label: "null output item", payload: { output: [null] }, commits: false },
  { label: "empty output item", payload: { output: [{}] }, commits: false },
  { label: "unknown output item", payload: { output: [{ type: "unknown", encrypted_content: "fixture" }] }, commits: false },
  { label: "missing ciphertext", payload: { output: [{ type: "compaction" }] }, commits: false },
  { label: "numeric ciphertext", payload: { output: [{ type: "compaction", encrypted_content: 42 }] }, commits: false },
  { label: "blank ciphertext", payload: { output: [{ type: "compaction", encrypted_content: "  " }] }, commits: false },
  { label: "missing message content", payload: { output: [{ type: "message", role: "user" }] }, commits: false },
  { label: "blank message", payload: { output: [{ ...message, content: [{ type: "input_text", text: " " }] }] }, commits: false },
  { label: "malformed message beside blob", payload: { output: [blobB, { type: "message", role: "user", content: 42 }] }, commits: false },
  { label: "reasoning without replacement", payload: { output: [{ type: "reasoning", summary: [] }] }, commits: false },
  { label: "nonobject JSON", payload: [blobB], commits: false },
  { label: "null JSON", payload: null, commits: false },
  { label: "invalid JSON", text: "{invalid compact fixture", commits: false },
  { label: "empty body", text: "", commits: false },
  { label: "HTTP 503", payload: failed, status: 503, commits: false },
  { label: "compact envelope", payload: { object: "response.compaction", output: [blobB] }, commits: true },
  { label: "completed compact", payload: { status: "completed", output: [blobB], error: null }, commits: true },
  { label: "compact alias", payload: { output: [{ ...blobB, type: "compaction_summary" }] }, commits: true },
  { label: "context compact alias", payload: { output: [{ ...blobB, type: "context_compaction" }] }, commits: true },
  { label: "plaintext replacement", payload: { output: [message] }, commits: true },
  { label: "assistant replacement", payload: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Replacement summary fixture." }] }] }, commits: true },
  { label: "retained history and compact", payload: { output: [message, { type: "reasoning", summary: [] }, blobB] }, commits: true },
].flatMap(row => (["A", "B"] as const).map(replayCredential => ({ ...row, replayCredential })));

describe("native compact provenance publication", () => {
  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-compact-provenance-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    release?.();
    globalThis.fetch = originalFetch;
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  test.each(rows)("$label then ordinary replay under $replayCredential", async row => {
    const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
    const compactText = "text" in row ? row.text : JSON.stringify(row.payload);
    const compactStatus = "status" in row ? row.status : 200;
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get("authorization") });
      return String(url).endsWith("/compact")
        ? new Response(compactText, { status: compactStatus, headers: { "content-type": "application/json" } })
        : Response.json({ ...completedPayload("Ordinary replay fixture."), output: [blobA] });
    }) as typeof fetch;
    const provider = { adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key" as const,
      apiKey: "provenance-a-fixture", supportsNativeCompactEndpoint: true, decodesNativeCompactionBlobs: true,
      transientRetryOn5xx: { attempts: 1 } };
    const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: provider } };
    const headers = { "x-codex-parent-thread-id": `provenance-${row.label}-${row.replayCredential}-fixture`, "thread-id": "child-fixture" };
    const request = (input: unknown[]) => compactionRequest(baseCompactionBody({ input }), undefined, headers);
    const seeded = await handleResponses(request([message]), config, { model: "", provider: "" });
    expect(seeded.status).toBe(200);
    expect((await seeded.json()).output).toEqual([blobA]);
    provider.apiKey = "provenance-b-fixture";
    const log: RequestLogContext = { model: "", provider: "" };
    const compact = await handleResponsesCompact(request([blobA, { ...message,
      internal_chat_message_metadata_passthrough: { private_fixture: "retained-in-client-only" },
    }]), config, log);
    expect(compact.status).toBe(compactStatus);
    expect(await compact.text()).toBe(compactText);
    expect(calls[1]!.body.input).not.toContainEqual(blobA);
    expect(JSON.stringify(calls[1]!.body)).not.toContain("internal_chat_message_metadata_passthrough");
    const payload = "payload" in row ? row.payload : undefined;
    if (compactStatus === 200 && payload && !Array.isArray(payload) && "status" in payload
      && ["completed", "failed", "incomplete"].includes(String(payload.status))) {
      expect(log.observedTerminalStatus).toBe(payload.status);
    }
    provider.apiKey = row.replayCredential === "A" ? "provenance-a-fixture" : "provenance-b-fixture";
    // Replay a blob actually returned by compact, or probe the prior A blob after text replacement.
    const output = payload && !Array.isArray(payload) && "output" in payload ? payload.output : undefined;
    const minted = Array.isArray(output) ? output.find(item => item && typeof item === "object"
      && "encrypted_content" in item && item.encrypted_content === blobB.encrypted_content) : undefined;
    const replay = row.commits && minted ? minted as typeof blobB : blobA;
    const ordinary = await handleResponses(request([replay]), config, { model: "", provider: "" });
    expect(ordinary.status).toBe(200);
    await ordinary.text();
    expect(calls).toHaveLength(3);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact", "/v1/responses"]);
    expect(calls.map(call => call.authorization)).toEqual(["Bearer provenance-a-fixture", "Bearer provenance-b-fixture", `Bearer provenance-${row.replayCredential.toLowerCase()}-fixture`]);
    const sameIssuer = row.replayCredential === (row.commits ? "B" : "A");
    if (sameIssuer) expect(calls[2]!.body.input).toContainEqual(replay);
    else {
      expect(calls[2]!.body.input).not.toContainEqual(replay);
      expect(JSON.stringify(calls[2]!.body)).not.toContain(replay.encrypted_content);
    }
  });

  test.each([failed, { status: "completed", output: [] }, { object: "response.compaction", output: [blobB] }])(
    "canonical compact preserves its existing body contract: %j", async payload => {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return Response.json(payload); }) as typeof fetch;
      const config = { ...getDefaultConfig(), defaultProvider: "gw", providers: { gw: {
        adapter: "openai-responses", authMode: "forward" as const, baseUrl: "https://chatgpt.com/backend-api/codex",
      } } };
      const response = await handleResponsesCompact(compactionRequest(baseCompactionBody(), undefined, {
        authorization: "Bearer canonical-fixture",
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(payload);
      expect(calls).toBe(1);
    });
});
