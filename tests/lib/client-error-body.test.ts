import { expect, test } from "bun:test";
import { OPENAI_ERROR_TYPES, OPENAI_ERROR_CODES, ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES,
  CLAUDE_CONTEXT_OVERFLOW_MESSAGE, CLIENT_ERROR_CONTRACTS, ownedChatErrorPayload, canonicalSseErrorBlock } from "../../src/lib/client-error-body";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
const KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
for (const token of ["constructor", "__proto__", "toString", KEY, "resource_exhausted"]) {
  for (const status of [400, 401, 404, 429, 502]) test(`closed defaults ${token} ${status}`, () => {
    const payload = ownedChatErrorPayload({ status, type: token, code: token, evidence: { status, type: token, code: token, message: KEY } });
    expect(payload.error.type).toBe(status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error");
    expect(payload.error.code).toBe(status === 401 ? "invalid_api_key" : status === 404 ? "model_not_found" : status === 429 ? "rate_limit_exceeded" : null);
    expect(payload.error.param).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(KEY);
    expect(OPENAI_ERROR_TYPES.get(token)).toBeUndefined();
    expect(OPENAI_ERROR_CODES.get(token)).toBeUndefined();
  });
}
for (const contract of Object.keys(CLIENT_ERROR_CONTRACTS) as Array<keyof typeof CLIENT_ERROR_CONTRACTS>) test(`fixed contract ${contract}`, () => {
  const payload = ownedChatErrorPayload({ status: 400, contract, evidence: { status: 400, message: KEY } });
  expect(payload.error.type).toBe("invalid_request_error");
  expect(payload.error.code).toBeNull();
  expect(payload.error.message).toBe(CLIENT_ERROR_CONTRACTS[contract]);
  expect(canonicalSseErrorBlock(payload)).toBe(`data: ${JSON.stringify(payload)}\n\n`);
  expect(JSON.stringify(payload)).not.toContain(KEY);
});
test("configured provider id grammar and Anthropic exports", () => {
  const payload = (providerId: string) => ownedChatErrorPayload({ status: 500, providerId, evidence: { status: 500 } });
  expect(payload("fixture-1").error.message).toContain("(provider: fixture-1)");
  expect(payload("bad/id").error.message).toBe(payload("").error.message);
  expect(CLAUDE_CONTEXT_OVERFLOW_MESSAGE).toBe("prompt is too long: The request exceeds the model's context window.");
  for (const type of ["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error", "timeout_error", "conflict_error"]) {
    expect(ANTHROPIC_ERROR_TYPES.get(type)).toBe(type);
    expect(ANTHROPIC_ERROR_CODES.get(type)).toBe(type);
  }
  for (const token of ["constructor", "__proto__", "toString"]) {
    expect(ANTHROPIC_ERROR_TYPES.get(token)).toBeUndefined();
    expect(ANTHROPIC_ERROR_CODES.get(token)).toBeUndefined();
  }
});
type CodeToken = { text: string; literal?: string };
function codeTokens(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\?\.|\?\?|===|!==|==|!=|=>|\|\||&&|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    if (text.startsWith("//") || text.startsWith("/*")) continue;
    tokens.push(text.startsWith('"') || text.startsWith("'") ? { text, literal: text.slice(1, -1) } : { text });
  }
  return tokens;
}
function expressionEnd(tokens: CodeToken[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.literal !== undefined) continue;
    if (["(", "[", "{"].includes(token.text)) depth++;
    else if ([")", "]", "}"].includes(token.text)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && [",", ";"].includes(token.text)) return i;
  }
  return tokens.length;
}
function resultCodes(tokens: CodeToken[], bindings: ReadonlyMap<string, string>): string[] {
  if (tokens[0]?.text === "(" && expressionEnd(tokens, 1) === tokens.length - 1) return resultCodes(tokens.slice(1, -1), bindings);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.literal !== undefined) continue;
    if (["(", "[", "{"].includes(token.text)) depth++;
    else if ([")", "]", "}"].includes(token.text)) depth--;
    else if (depth === 0 && token.text === "?") {
      let nested = 0; let branchDepth = 0;
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j]!;
        if (next.literal !== undefined) continue;
        if (["(", "[", "{"].includes(next.text)) branchDepth++;
        else if ([")", "]", "}"].includes(next.text)) branchDepth--;
        else if (branchDepth === 0 && next.text === "?") nested++;
        else if (branchDepth === 0 && next.text === ":") {
          if (nested-- === 0) return [...resultCodes(tokens.slice(i + 1, j), bindings), ...resultCodes(tokens.slice(j + 1), bindings)];
        }
      }
    } else if (depth === 0 && ["??", "||"].includes(token.text)) return [...resultCodes(tokens.slice(0, i), bindings), ...resultCodes(tokens.slice(i + 1), bindings)];
  }
  if (tokens.length !== 1) return [];
  const token = tokens[0]!; const value = token.literal ?? bindings.get(token.text);
  return value === undefined ? [] : [value];
}
function emittedChatCodes(source: string, nativeSse: boolean, bindings: ReadonlyMap<string, string> = new Map()): Set<string> {
  const tokens = codeTokens(source); const codes = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "code" && [":", "="].includes(tokens[i + 1]?.text ?? "")) {
      for (const code of resultCodes(tokens.slice(i + 2, expressionEnd(tokens, i + 2)), bindings)) codes.add(code);
    }
    const position = token.text === "fail" && nativeSse ? 2
      : ["failLocal", "failUpstream", "chatCompletionsErrorBody", "chatCompletionsErrorResponse", "ownedChatErrorResponse"].includes(token.text) ? 3 : undefined;
    if (position === undefined || tokens[i + 1]?.text !== "(") continue;
    let start = i + 2;
    for (let arg = 0; arg <= position; arg++) {
      const end = expressionEnd(tokens, start);
      if (arg === position) for (const code of resultCodes(tokens.slice(start, end), bindings)) codes.add(code);
      if (tokens[end]?.text !== ",") break;
      start = end + 1;
    }
  }
  return codes;
}
test("Chat code oracle reads positional arguments and conditional result branches", () => {
  const source = `fail(controller, "message", overflow ? "translation_buffer_limit" : stalled ? "upstream_stall_timeout" : "upstream_sse_error");
    failUpstream(502, "message", "upstream_error", "upstream_sse_truncated");
    new ChatCompletionsStreamError("message", { code: typeof value === "string" ? "invalid_refusal" : "upstream_incomplete" });
    classified.code = flag ? "invalid_prompt" : "cyber_policy";`;
  expect(emittedChatCodes(source, true)).toEqual(new Set(["translation_buffer_limit", "upstream_stall_timeout", "upstream_sse_error", "upstream_sse_truncated", "invalid_refusal", "upstream_incomplete", "invalid_prompt", "cyber_policy"]));
});
test("literal Chat writer codes are declared, including positional and conditional arguments", () => {
  const paths = ["src/chat/outbound.ts", "src/server/chat-native.ts", "src/server/chat-native-sse.ts", "src/server/chat-completions.ts", "src/protocols/encoders/chat.ts"];
  const sources = new Map([...paths, "src/lib/errors.ts", "src/lib/upstream-retry.ts"].map(path => [path, readFileSync(repoPath(path), "utf8")]));
  const bindings = new Map<string, string>();
  for (const source of sources.values()) {
    const tokens = codeTokens(source);
    for (let i = 0; i < tokens.length; i++) if (tokens[i]!.text === "const" && tokens[i + 2]?.text === "=" && tokens[i + 3]?.literal !== undefined) bindings.set(tokens[i + 1]!.text, tokens[i + 3]!.literal!);
  }
  const missing: string[] = [];
  for (const path of paths) for (const code of emittedChatCodes(sources.get(path)!, path.endsWith("chat-native-sse.ts"), bindings)) {
    if (!OPENAI_ERROR_CODES.has(code)) missing.push(`${path}: ${code}`);
  }
  expect(missing).toEqual([]);
});

test("local guidance requires a proxy-owned reason", () => {
  const options = { status: 429, type: "rate_limit_error", code: "request_send_budget_exhausted", evidence: { status: 429, message: KEY } };
  const neutral = ownedChatErrorPayload(options);
  expect(neutral.error.type).toBe("rate_limit_error"); expect(neutral.error.code).toBe("request_send_budget_exhausted");
  expect(neutral.error.message).toBe("The provider rate limit was reached; retry later.");
  const local = ownedChatErrorPayload({ ...options, localReason: "request_send_budget_exhausted" });
  expect(local.error.code).toBe(neutral.error.code); expect(local.error.message).toContain("proxy's send budget");
  expect(JSON.stringify(local)).not.toContain(KEY);
  const paused = ownedChatErrorPayload({ ...options, localReason: "credentials_paused" });
  expect(paused.error.code).toBe(neutral.error.code); expect(paused.error.message).toContain("Resume an account or key");
  expect(JSON.stringify(paused)).not.toContain(KEY);
});

test("known Chat codes retain their identities, including a local usage refusal", () => {
  for (const code of ["context_length_exceeded", "insufficient_quota", "rate_limit_exceeded", "model_not_found", "usage_limit_reached"]) {
    const payload = ownedChatErrorPayload({ status: 429, type: "rate_limit_error", code,
      ...(code === "usage_limit_reached" ? { localReason: "usage_limit_reached" } : {}), evidence: { status: 429, code, message: KEY } });
    expect(payload.error.type).toBe("rate_limit_error"); expect(payload.error.code).toBe(code);
    if (code === "usage_limit_reached") expect(payload.error.message).toBe("The configured usage limit was reached. Review the proxy's usage limits before retrying.");
    expect(JSON.stringify(payload)).not.toContain(KEY);
  }
});
test("actionable plan refusal keeps a proxy-written message with the proxy's copy of its token", () => {
  const PLAN = CLIENT_ERROR_CONTRACTS.model_not_in_plan;
  expect(PLAN).toContain("(MODEL_NOT_IN_PLAN)");
  const owned = (code: string | null | undefined, evidence: { code?: string; message?: string }, contract?: keyof typeof CLIENT_ERROR_CONTRACTS) =>
    ownedChatErrorPayload({ status: 400, type: "invalid_request_error", code, ...(contract ? { contract } : {}), evidence: { status: 400, ...evidence } }).error;
  // Structured code, exact after case and hyphen folding; the final wire code is unchanged.
  for (const structured of ["model_not_in_plan", "MODEL_NOT_IN_PLAN", " model-not-in-plan "]) {
    const error = owned("invalid_request_error", { code: structured, message: KEY });
    expect(error).toEqual({ message: PLAN, type: "invalid_request_error", param: null, code: "invalid_request_error" });
  }
  // A refusal-carrying code with the token as a whole word in the message.
  for (const code of ["invalid_prompt", "model_not_in_plan"]) {
    const error = owned(code, { message: `${KEY} refused (MODEL_NOT_IN_PLAN). ${KEY}` }, code === "invalid_prompt" ? "invalid_prompt" : undefined);
    expect(error).toEqual({ message: PLAN, type: "invalid_request_error", param: null, code });
    expect(JSON.stringify(error)).not.toContain(KEY);
  }
  // Not matched: a longer token, a non-carrier code reading message text, or another contract.
  expect(owned("invalid_prompt", { message: "MODEL_NOT_IN_PLAN_OTHER" }).message).toBe(CLIENT_ERROR_CONTRACTS.invalid_prompt);
  expect(owned("invalid_request_error", { message: "MODEL_NOT_IN_PLAN" }).message).not.toBe(PLAN);
  expect(owned("cyber_policy", { code: "model_not_in_plan" }, "cyber_policy").message).toBe(CLIENT_ERROR_CONTRACTS.cyber_policy);
  expect(owned("invalid_request_error", { code: KEY + "MODEL_NOT_IN_PLAN" }).message).not.toBe(PLAN);
});

test("proxy error identity and messages belong to their original request", async () => {
  const { markProxyError, isProxyError, carryProxyError, rememberProxyErrorMessage, hasProxyErrorMessage,
    fixedProxyErrorMessage } = await import("../../src/lib/client-error-body");
  const local = markProxyError(Response.json({ error: { message: "owned local refusal" } }, { status: 403 }));
  const copy = Response.json({ error: { message: "owned local refusal", proxyAuthored: true } }, { status: 403 });
  expect(local.status).toBe(403);
  expect(copy.status).toBe(403);
  expect(isProxyError(local)).toBe(true);
  expect(isProxyError(copy)).toBe(false);
  expect(isProxyError(carryProxyError(local, new Response(null)))).toBe(true);
  expect(isProxyError(carryProxyError(copy, new Response(null)))).toBe(false);
  const context = {};
  rememberProxyErrorMessage(context, "owned tool refusal", { status: 502 });
  expect(hasProxyErrorMessage(context, "owned tool refusal", {})).toBe(true);
  expect(hasProxyErrorMessage({}, "owned tool refusal", {})).toBe(false);
  expect(hasProxyErrorMessage(context, `owned tool refusal ${KEY}`, {})).toBe(false);
  expect(fixedProxyErrorMessage("upstream stream ended early (upstream_stall_timeout)"))
    .toBeUndefined();
  expect(fixedProxyErrorMessage(`upstream stream ended early (${KEY})`)).toBeUndefined();
  expect(fixedProxyErrorMessage(`upstream stream ended early (upstream_stall_timeout) ${KEY}`)).toBeUndefined();
});

test("an exact proxy sentence never grants upstream type or code ownership", () => {
  for (const status of [400, 502]) {
    const body = ownedChatErrorPayload({ status, type: KEY, code: KEY,
      evidence: { status, type: KEY, code: KEY, message: "upstream response contained no choices" } });
    expect(body.error.type).toBe(status === 400 ? "invalid_request_error" : "server_error");
    expect(body.error.code).toBeNull();
    expect(body.error.message).toBe("upstream response contained no choices");
    expect(JSON.stringify(body)).not.toContain(KEY);
  }
});

const LOCAL_DIAGNOSTICS = [
  "internal replay returned a non-JSON response",
  "upstream returned malformed Chat Completions JSON",
  "upstream response contained no choices",
  "upstream response ended without a supported completion boundary",
  "upstream returned malformed SSE JSON",
  "upstream returned an invalid SSE event",
  "upstream SSE ended with an unterminated event",
  "upstream SSE ended mid tool call without a terminal signal — possible truncation",
  "upstream SSE ended before a terminal event",
  "upstream stream stalled without meaningful progress",
];
test("locally generated structural diagnostics retain their exact proxy sentences", () => {
  for (const message of LOCAL_DIAGNOSTICS) {
    const body = ownedChatErrorPayload({ status: 502, type: "upstream_error", code: "upstream_server_error",
      evidence: { status: 502, message } });
    expect(body.error.type).toBe("upstream_error");
    expect(body.error.code).toBe("upstream_server_error");
    expect(body.error.message).toBe(message);
    const copy = ownedChatErrorPayload({ status: 502, type: KEY, code: KEY,
      evidence: { status: 502, message: `${message} ${KEY}` } });
    expect(copy.error.type).toBe("server_error");
    expect(copy.error.code).toBeNull();
    expect(JSON.stringify(copy)).not.toContain(KEY);
  }
});

test("fixed proxy diagnostics retain cyber and context contract precedence", () => {
  for (const [code, message] of [["cyber_policy", CLIENT_ERROR_CONTRACTS.cyber_policy],
    ["context_length_exceeded", CLIENT_ERROR_CONTRACTS.context_overflow]]) {
    const body = ownedChatErrorPayload({ status: 400, code,
      evidence: { status: 400, message: "upstream stream ended early (upstream_stall_timeout)" } });
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(message);
  }
});

test("committed combo context observes a local guard decision made later", async () => {
  const { carryProxyErrorContext, rememberProxyErrorMessage, hasProxyErrorMessage } = await import("../../src/lib/client-error-body");
  const child = {}; const parent = {}; const other = {};
  carryProxyErrorContext(child, parent);
  expect(hasProxyErrorMessage(parent, "owned late refusal", {})).toBe(false);
  rememberProxyErrorMessage(child, "owned late refusal", { status: 502 });
  expect(hasProxyErrorMessage(parent, "owned late refusal", {})).toBe(true);
  expect(hasProxyErrorMessage(other, "owned late refusal", {})).toBe(false);
  expect(hasProxyErrorMessage(parent, `owned late refusal ${KEY}`, {})).toBe(false);
});

test("synthetic incomplete origins stay with the producer context", async () => {
  const { rememberProxyIncomplete, hasProxyIncomplete, carryProxyIncompleteContext } = await import("../../src/lib/client-error-body");
  const context = {}; const stream = {};
  carryProxyIncompleteContext(context, stream);
  expect(hasProxyIncomplete(context, "adapter_eof")).toBe(false);
  rememberProxyIncomplete(context, "adapter_eof");
  expect(hasProxyIncomplete(context, "adapter_eof")).toBe(true);
  expect(hasProxyIncomplete(stream, "adapter_eof")).toBe(true);
  expect(hasProxyIncomplete({}, "adapter_eof")).toBe(false);
  expect(hasProxyIncomplete({ proxyAuthored: true }, "adapter_eof")).toBe(false);
  expect(hasProxyIncomplete(context, "upstream_stall_timeout")).toBe(false);
  expect(hasProxyIncomplete(context, KEY)).toBe(false);
  expect(hasProxyIncomplete(context, "adapter_eof", KEY)).toBe(false);
  expect(hasProxyIncomplete(context, "adapter_eof", "upstream stream ended early (adapter_eof)")).toBe(false);
});

test("committed combo context carries later synthetic incomplete origins", async () => {
  const { carryProxyErrorContext, rememberProxyIncomplete, hasProxyIncomplete } = await import("../../src/lib/client-error-body");
  const child = {}; const parent = {};
  carryProxyErrorContext(child, parent);
  expect(hasProxyIncomplete(parent, "adapter_eof")).toBe(false);
  rememberProxyIncomplete(child, "adapter_eof");
  expect(hasProxyIncomplete(parent, "adapter_eof")).toBe(true);
  expect(hasProxyIncomplete({}, "adapter_eof")).toBe(false);
});
