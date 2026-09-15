import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  applyAccountChangeConversationStateScrub,
  canPortConversationState,
  collectConversationStateCarriers,
} from "../../src/server/responses/account-change-state";
import {
  clearConversationStateIssuerMap,
  rememberConversationStateIssuer,
} from "../../src/codex/routing";
import type { RequestLogContext } from "../../src/server/request-log";

const BINDING_KEY = "thread-account-change-scrub";
const ENCRYPTED = "gAAAA" + "A".repeat(80);

function userMessage(text: string) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function reasoningBlob(encrypted = ENCRYPTED) {
  return {
    type: "reasoning",
    id: "rs_account_change",
    summary: [{ type: "summary_text", text: "kept summary" }],
    encrypted_content: encrypted,
  };
}

function turnBody(text = "keep this user turn") {
  return {
    model: "gpt-5.4",
    previous_response_id: "resp_account_a",
    input: [userMessage(text), reasoningBlob()],
  };
}

function compactTurnBody(text = "keep this compact user turn") {
  return {
    model: "gpt-5.4",
    previous_response_id: "resp_account_a",
    input: [
      userMessage(text),
      reasoningBlob(),
      { type: "compaction_trigger" },
    ],
  };
}

describe("Codex pool account-change conversation-state scrub", () => {
  afterEach(() => {
    clearConversationStateIssuerMap();
  });

  test("a turn served by the same account keeps previous_response_id and encrypted reasoning", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = turnBody();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const scrubbed = applyAccountChangeConversationStateScrub({
      body,
      bindingKey: BINDING_KEY,
      servingAccountId: "account-a",
      logCtx,
    });
    expect(scrubbed).toBe(false);
    expect(body.previous_response_id).toBe("resp_account_a");
    expect(body.input[1]).toEqual(reasoningBlob());
    expect(body.input[0]).toEqual(userMessage("keep this user turn"));
    expect(logCtx.conversationStateScrub).toBeUndefined();
  });

  test("a serving-account change drops the continuation id while keeping the readable user message", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = turnBody("hello from the user");
    const parsed = { previousResponseId: "resp_account_a" as string | undefined };
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const scrubbed = applyAccountChangeConversationStateScrub({
        body,
        parsed,
        bindingKey: BINDING_KEY,
        servingAccountId: "account-b",
        logCtx,
      });
      expect(scrubbed).toBe(true);
      expect(body.previous_response_id).toBeUndefined();
      expect(parsed.previousResponseId).toBeUndefined();
      expect(parsed._stripReasoningEncryptedContent).toBe(true);
      // Encrypted reasoning is #2247's job and keeps its established shape, so this layer must
      // leave it exactly as it found it. What this layer owns is the continuation id.
      expect((body.input[1] as { encrypted_content?: string }).encrypted_content).toBe(ENCRYPTED);
      expect(JSON.stringify(body.input[0])).toContain("hello from the user");
      expect(logCtx.conversationStateScrub).toBe("account-change");
      expect(warn).toHaveBeenCalledWith(
        "[opencodex] dropped continuation state after a Codex pool account change; continuing fresh",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("the compact routed-fallback body obeys the same account-change rule", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = compactTurnBody("compact me later");
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(applyAccountChangeConversationStateScrub({
        body,
        bindingKey: BINDING_KEY,
        servingAccountId: "account-b",
        logCtx,
      })).toBe(true);
      expect(body.previous_response_id).toBeUndefined();
      // Encrypted reasoning is #2247's job and keeps its established shape, so this layer must
      // leave it exactly as it found it. What this layer owns is the continuation id.
      expect((body.input[1] as { encrypted_content?: string }).encrypted_content).toBe(ENCRYPTED);
      expect(JSON.stringify(body.input[0])).toContain("compact me later");
      expect(body.input.some((item) => item && (item as { type?: string }).type === "compaction_trigger")).toBe(true);
      expect(logCtx.conversationStateScrub).toBe("account-change");
    } finally {
      warn.mockRestore();
    }
  });

  test("an in-request alternate-account retry scrubs even before an issuer is recorded", () => {
    const body = turnBody();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    expect(applyAccountChangeConversationStateScrub({
      body,
      bindingKey: BINDING_KEY,
      servingAccountId: "account-b",
      priorAccountId: "account-a",
      logCtx,
    })).toBe(true);
    expect(body.previous_response_id).toBeUndefined();
    expect(logCtx.conversationStateScrub).toBe("account-change");
  });

  test("canPortConversationState refuses continuation ids, provider ids and encrypted reasoning", () => {
    expect(canPortConversationState({})).toEqual({ portable: true });
    expect(canPortConversationState({ previousResponseId: "resp_1" })).toEqual({
      portable: false,
      reason: "previous-response-id",
    });
    expect(collectConversationStateCarriers(turnBody()).previousResponseId).toBe("resp_account_a");
    expect(collectConversationStateCarriers(turnBody()).encryptedReasoning).toBe(true);
  });
});

