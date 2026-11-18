import { describe, expect, test } from "bun:test";
import { DEVELOPER_ROLE_REFUSAL_MESSAGE, ownedChatErrorPayload } from "../../src/lib/client-error-body";
import { isDeveloperRoleRejection } from "../../src/lib/developer-role-rejection";
import { ownedAnthropicErrorPayload } from "../../src/lib/messages-error-body";
import { upstreamConditionMessage } from "../../src/lib/upstream-condition";
import { recordUpstreamProviderErrorDetail, recordUpstreamValidationDetail, type FailureDetail } from "../../src/server/request-log-failure-detail";

// #8864: DashScope compatible-mode rejects the developer role with a 400 the proxy used to report only as
// "The provider rejected the request." The cause must reach the client and the request log as proxy-owned
// facts: a fixed sentence and the closed pair messages.role/enum. No upstream text is kept.
const DASHSCOPE = "developer is not one of ['system','assistant','user','tool','function'] - 'messages.[0].role'";
const MOONSHOT = "Invalid request: role 'developer' is not allowed";
const SERDE = "Failed to deserialize the JSON body into the target type: messages[0].role: unknown variant `developer`, expected one of `system`, `user`";
const UNRELATED = "Invalid value for 'temperature': must be between 0 and 2";
const body = (message: string) => ({ error: { message, type: "invalid_request_error", param: null, code: "invalid_request_error" } });

describe("developer-role rejection verdict", () => {
  test.each([DASHSCOPE, MOONSHOT, SERDE, DASHSCOPE.toUpperCase()])("recognizes %s", message => {
    expect(isDeveloperRoleRejection(400, message)).toBe(true);
    expect(isDeveloperRoleRejection(422, message)).toBe(true);
  });

  test.each([
    ["a server error", 500, DASHSCOPE],
    ["a success status", 200, DASHSCOPE],
    ["a missing status", undefined, DASHSCOPE],
    ["a non-string message", 400, { message: DASHSCOPE }],
    ["another role", 400, "role 'system' is not allowed"],
    ["an unrelated 400", 400, UNRELATED],
    ["prose about developers", 400, "The developer of this model has not enabled tools for your account."],
    ["a phrase past the scan bound", 400, "x".repeat(4096) + DASHSCOPE],
  ])("ignores %s", (_name, status, message) => {
    expect(isDeveloperRoleRejection(status as number | undefined, message)).toBe(false);
  });
});

describe("client sentence", () => {
  const chat = (message: string, extra: Partial<Parameters<typeof ownedChatErrorPayload>[0]> = {}) => ownedChatErrorPayload({
    status: 400, type: "invalid_request_error", code: "invalid_request_error",
    evidence: { status: 400, type: "invalid_request_error", code: "invalid_request_error", message }, ...extra,
  }).error;

  test("a Chat role rejection names the cause without quoting the provider", () => {
    const error = chat(DASHSCOPE);
    expect(error).toEqual({ message: DEVELOPER_ROLE_REFUSAL_MESSAGE, type: "invalid_request_error", param: null, code: "invalid_request_error" });
    expect(error.message).not.toContain("is not one of");
    expect(chat(MOONSHOT, { code: null }).message).toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
  });

  test("an unrelated 400 keeps the generic rejection sentence", () => {
    expect(chat(UNRELATED).message).toBe(upstreamConditionMessage("request_rejected"));
  });

  test("a contract or a policy code keeps its own sentence", () => {
    expect(chat(DASHSCOPE, { contract: "stream_incomplete" }).message).not.toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
    expect(chat(DASHSCOPE, { code: "cyber_policy" }).message).not.toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
    expect(chat(DASHSCOPE, { code: "context_length_exceeded" }).message).not.toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
  });

  test("the Messages surface uses the same sentence", () => {
    const payload = ownedAnthropicErrorPayload({ status: 400, type: "invalid_request_error", evidence: { status: 400, message: DASHSCOPE } });
    expect((payload.error as { message: string }).message).toBe(DEVELOPER_ROLE_REFUSAL_MESSAGE);
  });
});

describe("request-log detail", () => {
  test("a provider body records the closed messages.role pair and nothing it wrote", () => {
    const ctx: { failureDetail?: FailureDetail } = {};
    recordUpstreamProviderErrorDetail(ctx, 400, JSON.stringify(body(DASHSCOPE)));
    expect(ctx.failureDetail).toEqual({ code: "provider_error", type: "invalid_request_error", validation: [{ field: "messages.role", type: "enum" }] });
    expect(JSON.stringify(ctx.failureDetail)).not.toMatch(/not one of|assistant|function/);
  });

  test("an unrelated provider 400 records only its closed class", () => {
    const ctx: { failureDetail?: FailureDetail } = {};
    recordUpstreamProviderErrorDetail(ctx, 400, body(UNRELATED));
    expect(ctx.failureDetail).toEqual({ code: "provider_error", type: "invalid_request_error" });
  });

  test("a body this proxy formatted is not read for the phrase", () => {
    const ctx: { failureDetail?: FailureDetail } = {};
    recordUpstreamValidationDetail(ctx, 400, JSON.stringify(body(DASHSCOPE)));
    expect(ctx.failureDetail).toBeUndefined();
  });

  test("a structured validation list still wins", () => {
    const ctx: { failureDetail?: FailureDetail } = {};
    recordUpstreamProviderErrorDetail(ctx, 422, { detail: [{ type: "extra_forbidden", loc: ["body", "store"] }], error: { message: DASHSCOPE } });
    expect(ctx.failureDetail?.validation).toEqual([{ field: "store", type: "extra_forbidden" }]);
  });
});
