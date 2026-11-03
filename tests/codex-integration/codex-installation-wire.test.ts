import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodexAuthContextToProvider, headersForCodexAuthContext, materializeCodexUpstreamAuthAsync, type CodexAuthContext } from "../../src/codex/auth-context";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { selectForwardHeaders } from "../../src/server/ws-bridge";
import { codexWsReuseIdentity } from "../../src/server/responses/codex-ws-pool";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { codexInstallationIdForAccount } from "../../src/codex/installation-id";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";

const key = "x-codex-installation-id";
const original = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const base: OcxProviderConfig = { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };
const pool = (account = "account-a", token = "token-a"): CodexAuthContext => ({ kind: "pool", accountId: account, chatgptAccountId: account, accessToken: token, generation: 1, writerGeneration: 0 });
let root: string;
let previous: string | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-installation-wire-")); previous = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = root; });
afterEach(() => { if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; rmSync(root, { recursive: true, force: true }); });
function incoming(id: string | undefined = original) { return new Headers({ authorization: "Bearer caller-token", ...(id === undefined ? {} : { [key]: id }) }); }
async function build(ctx: CodexAuthContext, metadata: Record<string, string>, id: string | undefined = original) {
  const raw = Object.freeze({ model: "gpt-5", input: [], client_metadata: Object.freeze(metadata) });
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: raw };
  const provider = applyCodexAuthContextToProvider(base, ctx, "pool");
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const request = await adapter.buildRequest(parsed, { headers: await materializeCodexUpstreamAuthAsync(incoming(id), ctx) });
  return { request, raw, provider };
}

test("Pool identity survives token refresh and changes of caller installation", () => {
  const a = headersForCodexAuthContext(incoming(), pool()).get(key);
  expect(headersForCodexAuthContext(incoming("caller-other"), pool("account-a", "refreshed")).get(key)).toBe(a);
  expect(a).not.toBe(original);
});
for (const kind of ["main", "main-pool"] as const) test(`${kind} preserves header and client metadata bytes`, async () => {
  const ctx: CodexAuthContext = kind === "main" ? { kind: "main", accountId: null } : { ...pool(), kind: "main-pool" } as CodexAuthContext;
  expect(headersForCodexAuthContext(incoming(), ctx).get(key)).toBe(original);
  const { request } = await build(ctx, { [key]: original });
  expect(new Headers(request.headers).get(key)).toBe(original);
  expect(JSON.parse(request.body).client_metadata[key]).toBe(original);
});

test("Pool HTTP/WS replace both surfaces without mutating raw body; failover A to B changes identity", async () => {
  const first = await build(pool(), { [key]: "different-body-id", thread_id: "thread", turn_id: "turn" });
  const second = await build(pool("account-b", "token-b"), { [key]: "different-body-id", thread_id: "thread", turn_id: "turn" });
  const identities = [];
  for (const { request, raw, provider } of [first, second]) {
    const id = new Headers(request.headers).get(key);
    expect(id).not.toBe(original);
    expect(JSON.parse(request.body).client_metadata[key]).toBe(id);
    expect(raw.client_metadata[key]).toBe("different-body-id");
    const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body })!;
    expect(prepared.headers[key]).toBe(id);
    expect(JSON.parse(prepared.frameText).client_metadata[key]).toBe(id);
    expect(selectForwardHeaders(incoming(), provider._codexAccountOverride).get(key)).toBe(id);
    identities.push(codexWsReuseIdentity(CODEX_RESPONSES_HTTP_URL, prepared.headers, prepared.frameText));
  }
  expect(new Headers(first.request.headers).get(key)).not.toBe(new Headers(second.request.headers).get(key));
  expect(identities[0]?.key).not.toBe(identities[1]?.key);
});

test("absent surfaces stay absent in materialization, adapter and WS preparation", async () => {
  const headers = incoming(); headers.delete(key);
  expect(headersForCodexAuthContext(headers, pool()).has(key)).toBe(false);
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(applyCodexAuthContextToProvider(base, pool(), "pool")));
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: { model: "gpt-5", input: [], client_metadata: { thread_id: "thread" } } };
  const request = await adapter.buildRequest(parsed, { headers });
  expect(new Headers(request.headers).has(key)).toBe(false);
  expect(JSON.parse(request.body).client_metadata[key]).toBeUndefined();
  const ws = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body })!;
  expect(ws.headers[key]).toBeUndefined();
  expect(JSON.parse(ws.frameText).client_metadata[key]).toBeUndefined();
});

for (const headerPresent of [false, true]) for (const bodyPresent of [false, true]) test(`independent existence gates header=${headerPresent}, body=${bodyPresent}`, async () => {
  const headers = incoming();
  if (!headerPresent) headers.delete(key);
  const provider = applyCodexAuthContextToProvider(base, pool(), "pool");
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const raw = { model: "gpt-5", input: [], ...(bodyPresent ? { client_metadata: { [key]: "" } } : {}) };
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: raw };
  const request = await adapter.buildRequest(parsed, { headers });
  const ws = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body })!;
  expect(Object.hasOwn(ws.headers, key)).toBe(headerPresent);
  expect(Object.hasOwn(JSON.parse(ws.frameText).client_metadata ?? {}, key)).toBe(bodyPresent);
  if (bodyPresent) expect(JSON.parse(ws.frameText).client_metadata[key]).toBe(codexInstallationIdForAccount("account-a"));
});

test("mixed-case static identity cannot revive caller data on Pool sends", async () => {
  const provider = applyCodexAuthContextToProvider({ ...base, headers: { "X-Codex-Installation-Id": "stale-static", "X-Oai-Attestation": "stale-attestation" } }, pool(), "pool");
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: { model: "gpt-5", input: [] } };
  const request = await adapter.buildRequest(parsed, { headers: incoming() });
  expect(new Headers(request.headers).get(key)).toBe(codexInstallationIdForAccount("account-a"));
  expect(new Headers(request.headers).has("x-oai-attestation")).toBe(false);
});

test("absent installation surfaces do not require identity storage during provider or wire preparation", async () => {
  const path = join(root, "codex-installation-secret");
  writeFileSync(path, "corrupt");
  const provider = applyCodexAuthContextToProvider(base, pool(), "pool");
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const headers = new Headers({ authorization: "Bearer caller-token" });
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: { model: "gpt-5", input: [] } };
  const selected = await materializeCodexUpstreamAuthAsync(headers, pool());
  const request = await adapter.buildRequest(parsed, { headers: selected });
  expect(new Headers(request.headers).has(key)).toBe(false);
  expect(JSON.parse(request.body).client_metadata?.[key]).toBeUndefined();
  const ws = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, { headers: request.headers, body: request.body })!;
  expect(ws.headers[key]).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe("corrupt");
  expect(() => headersForCodexAuthContext(incoming(), pool())).toThrow("Codex installation identity unavailable");
});

test("Direct recovers a blank account header from its bearer while preserving empty identity surfaces", async () => {
  const token = fakeChatGptJwt({ chatgpt_account_id: "caller-account" });
  const headers = new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": "", [key]: "", "x-codex-turn-metadata": "", "session-id": "" });
  const ctx: CodexAuthContext = { kind: "main", accountId: null };
  for (const selected of [headersForCodexAuthContext(headers, ctx), await materializeCodexUpstreamAuthAsync(headers, ctx)]) {
    expect(selected.get("authorization")).toBe(`Bearer ${token}`);
    expect(selected.get("chatgpt-account-id")).toBe("caller-account");
    expect(selected.get(key)).toBe("");
    expect(selected.get("x-codex-turn-metadata")).toBe("");
    expect(selected.has("session-id")).toBe(false);
  }
});

for (const kind of ["pool", "main", "main-pool"] as const) test(`${kind} provider defaults do not invent an installation surface`, async () => {
  const ctx: CodexAuthContext = kind === "main" ? { kind: "main", accountId: null } : { ...pool(), kind } as CodexAuthContext;
  const configured = { ...base, headers: { "X-Codex-Installation-Id": "static-id" } };
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(applyCodexAuthContextToProvider(configured, ctx, "pool")));
  const headers = incoming(); headers.delete(key);
  const parsed: OcxParsedRequest = { modelId: "gpt-5", stream: true, context: { messages: [] }, options: {}, _rawBody: { model: "gpt-5", input: [] } };
  const absent = await adapter.buildRequest(parsed, { headers });
  expect(new Headers(absent.headers).has(key)).toBe(false);
  if (kind !== "pool") {
    const present = await adapter.buildRequest(parsed, { headers: incoming() });
    expect(new Headers(present.headers).get(key)).toBe(original);
  }
});
