import { describe, expect, test } from "bun:test";
import { FORWARD_HEADERS, createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { headersForCodexAuthContext } from "../src/codex/auth-context";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const accountA = {
  accountId: "pool-a",
  accessToken: "pool_a_token",
  chatgptAccountId: "acct_pool_a",
};

const poolAuthContext = {
  kind: "pool" as const,
  accountId: accountA.accountId,
  generation: 1,
  accessToken: accountA.accessToken,
  chatgptAccountId: accountA.chatgptAccountId,
};

function minimalParsed(): OcxParsedRequest {
  return {
    modelId: "gpt-5.4",
    context: { messages: [] },
    stream: false,
    options: {},
    _rawBody: { model: "gpt-5.4", input: [] },
  };
}

describe("Codex metadata integrity", () => {
  test("FORWARD_HEADERS includes client metadata allowlist entries", () => {
    for (const name of [
      "originator",
      "session_id",
      "session-id",
      "thread-id",
      "chatgpt-account-id",
      "x-codex-parent-thread-id",
    ]) {
      expect(FORWARD_HEADERS).toContain(name);
    }
  });

  test("does not fabricate originator when absent", () => {
    const incoming = new Headers({
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("originator")).toBeNull();
    expect(headers.get("chatgpt-account-id")).toBe(accountA.chatgptAccountId);
  });

  test("preserves genuine originator", () => {
    const incoming = new Headers({
      originator: "codex_cli_rs",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  test("preserves genuine session_id and thread-id", () => {
    const incoming = new Headers({
      session_id: "sess-real-1",
      "thread-id": "thread-real-1",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("session_id")).toBe("sess-real-1");
    expect(headers.get("thread-id")).toBe("thread-real-1");
    expect(headers.get("x-codex-parent-thread-id")).toBe("thread-1");
  });

  test("does not fabricate session_id or thread-id when absent", () => {
    const headers = headersForCodexAuthContext(new Headers(), poolAuthContext);
    expect(headers.get("session_id")).toBeNull();
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("thread-id")).toBeNull();
    expect(headers.get("originator")).toBeNull();
  });

  test("outgoing chatgpt-account-id matches selected pool credential", () => {
    const incoming = new Headers({
      authorization: "Bearer caller_token",
      "chatgpt-account-id": "caller_acct_should_be_replaced",
      originator: "codex_cli_rs",
    });
    const headers = headersForCodexAuthContext(incoming, poolAuthContext);
    expect(headers.get("authorization")).toBe(`Bearer ${accountA.accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe(accountA.chatgptAccountId);
    expect(headers.get("originator")).toBe("codex_cli_rs");
  });

  test("main-pool auth context also overwrites chatgpt-account-id without fabricating originator", () => {
    const incoming = new Headers({
      "chatgpt-account-id": "stale_caller_acct",
      "x-codex-parent-thread-id": "thread-1",
    });
    const headers = headersForCodexAuthContext(incoming, {
      kind: "main-pool",
      accountId: "__main__",
      accessToken: "main_access",
      chatgptAccountId: "main_acct",
    });
    expect(headers.get("chatgpt-account-id")).toBe("main_acct");
    expect(headers.get("authorization")).toBe("Bearer main_access");
    expect(headers.get("originator")).toBeNull();
  });

  test("adapter forward mode does not fabricate originator and applies pool override", () => {
    const provider: OcxProviderConfig & {
      _codexAccountOverride: { accessToken: string; chatgptAccountId: string };
      _codexAccountRequired: boolean;
    } = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      _codexAccountRequired: true,
      _codexAccountOverride: {
        accessToken: accountA.accessToken,
        chatgptAccountId: accountA.chatgptAccountId,
      },
    };
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest(minimalParsed(), {
      headers: new Headers({
        "x-codex-parent-thread-id": "thread-1",
        "chatgpt-account-id": "caller_stale",
      }),
    });
    expect(request).not.toBeInstanceOf(Promise);
    const sync = request as { headers: Record<string, string> };
    expect(sync.headers.originator).toBeUndefined();
    expect(sync.headers["chatgpt-account-id"]).toBe(accountA.chatgptAccountId);
    expect(sync.headers.authorization).toBe(`Bearer ${accountA.accessToken}`);
  });

  test("adapter forward mode preserves genuine client metadata", () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    };
    const adapter = createResponsesPassthroughAdapter(provider);
    const request = adapter.buildRequest(minimalParsed(), {
      headers: new Headers({
        authorization: "Bearer caller-token",
        originator: "codex_cli_rs",
        session_id: "sess-real-2",
        "thread-id": "thread-real-2",
      }),
    });
    const sync = request as { headers: Record<string, string> };
    expect(sync.headers.authorization).toBe("Bearer caller-token");
    expect(sync.headers.originator).toBe("codex_cli_rs");
    expect(sync.headers.session_id).toBe("sess-real-2");
    expect(sync.headers["thread-id"]).toBe("thread-real-2");
  });
});
