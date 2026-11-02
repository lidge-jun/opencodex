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
