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
test("literal Chat writer codes are declared", () => {
  for (const path of ["src/chat/outbound.ts", "src/server/chat-native.ts", "src/server/chat-native-sse.ts", "src/server/chat-completions.ts", "src/protocols/encoders/chat.ts"]) {
    const source = readFileSync(repoPath(path), "utf8");
    for (const match of source.matchAll(/(?:code\s*(?::|=)|classified\.code\s*=)\s*"([a-z_]+)"/g)) expect(OPENAI_ERROR_CODES.has(match[1]!)).toBe(true);
  }
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
