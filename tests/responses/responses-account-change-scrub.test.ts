import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  applyAccountChangeConversationStateScrub,
  canPortConversationState,
  collectConversationStateCarriers,
  accountChangeFileReferenceRefusal,
  conversationCarriesUploadedFiles,
  ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE,
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

/**
 * An uploaded file is content the caller attached, not continuation state (#4710).
 *
 * The classifier has always called `file_id` account-bound and the scrubber has always removed
 * only `previous_response_id` and `conversation`, so a body whose only account-bound state was
 * a file reference reported nothing scrubbed and went to the new account unchanged. Deleting
 * the reference instead would answer a different question than the one that was asked, with no
 * way for the caller to tell, so the move is refused before dispatch.
 */
function fileOnlyBody() {
  return {
    model: "gpt-5.4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_file", file_id: "file_abc123" }] },
    ],
  };
}

describe("an account change refuses uploaded-file references instead of dropping them", () => {
  afterEach(() => { clearConversationStateIssuerMap(); });

  test("a file-only body is refused when the serving account is not the issuer", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = fileOnlyBody();
    // The gap this closes: the scrub reports nothing to do, which used to mean "carry on".
    expect(applyAccountChangeConversationStateScrub({
      body, bindingKey: BINDING_KEY, servingAccountId: "account-b",
    })).toBe(false);

    const refusal = accountChangeFileReferenceRefusal({
      body, bindingKey: BINDING_KEY, servingAccountId: "account-b",
    });
    expect(refusal?.status).toBe(400);
    // The reference is left byte-for-byte intact: refusing is the contract, not scrubbing.
    expect(collectConversationStateCarriers(body).fileIds).toEqual(["file_abc123"]);
  });

  test("the same body is served without complaint by its own issuer", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    expect(accountChangeFileReferenceRefusal({
      body: fileOnlyBody(), bindingKey: BINDING_KEY, servingAccountId: "account-a",
    })).toBeUndefined();
  });

  test("an in-request move is refused on the prior account alone, with no remembered issuer", () => {
    expect(accountChangeFileReferenceRefusal({
      body: fileOnlyBody(),
      bindingKey: BINDING_KEY,
      servingAccountId: "account-b",
      priorAccountId: "account-a",
    })?.status).toBe(400);
  });

  test("a file reference behind a previous_response_id is still found", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = { ...turnBody(), input: [...fileOnlyBody().input] } as Record<string, unknown>;
    body.previous_response_id = "resp_account_a";
    // The portability verdict reports only the FIRST reason it finds, so a body carrying both
    // would have reported the response id and let the file through the scrub untouched.
    expect(canPortConversationState(collectConversationStateCarriers(body)))
      .toMatchObject({ portable: false, reason: "previous-response-id" });
    expect(accountChangeFileReferenceRefusal({
      body, bindingKey: BINDING_KEY, servingAccountId: "account-b",
    })?.status).toBe(400);
  });

  test("a body with no file reference keeps the existing scrub-and-continue contract", () => {
    rememberConversationStateIssuer(BINDING_KEY, "account-a");
    const body = turnBody() as Record<string, unknown>;
    expect(accountChangeFileReferenceRefusal({
      body, bindingKey: BINDING_KEY, servingAccountId: "account-b",
    })).toBeUndefined();
    expect(applyAccountChangeConversationStateScrub({
      body, bindingKey: BINDING_KEY, servingAccountId: "account-b",
    })).toBe(true);
  });
});

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

/**
 * The alternate-account paths ask this question BEFORE they resolve an alternate (#4710).
 *
 * They cannot answer with a status the way the initial dispatch does, because an earlier
 * response already exists and is what the caller returns. So they refuse the move instead, and
 * the predicate they refuse on has to be answerable from the body alone -- no binding, no
 * serving account, no issuer -- since none of those are known yet at that point.
 */
describe("uploaded-file detection answers before an alternate account is chosen (#4710)", () => {
  function fileAttachment(id = "file_account_a") {
    return {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "what does this say?" },
        { type: "input_file", file_id: id },
      ],
    };
  }

  test("a file-only body is detected from the body alone", () => {
    expect(conversationCarriesUploadedFiles({ model: "gpt-5.4", input: [fileAttachment()] })).toBe(true);
  });

  test("a file behind a previous_response_id is still detected", () => {
    // The portability verdict reports only the first reason it finds, so a predicate built on it
    // would miss this body and let the retry sites move a file reference they already refused
    // to move when it appeared alone.
    expect(conversationCarriesUploadedFiles({
      model: "gpt-5.4",
      previous_response_id: "resp_account_a",
      input: [fileAttachment()],
    })).toBe(true);
  });

  test("top-level file_id and file_ids shapes are both detected", () => {
    expect(conversationCarriesUploadedFiles({
      input: [{ type: "message", role: "user", file_id: "file_1" }],
    })).toBe(true);
    expect(conversationCarriesUploadedFiles({
      input: [{ type: "message", role: "user", file_ids: ["file_2"] }],
    })).toBe(true);
  });

  test("a body with no uploaded file lets the move proceed", () => {
    // The retry sites must keep failing over for every ordinary body; a predicate that answered
    // true too often would silently disable alternate-account recovery.
    expect(conversationCarriesUploadedFiles(turnBody())).toBe(false);
    expect(conversationCarriesUploadedFiles(compactTurnBody())).toBe(false);
    expect(conversationCarriesUploadedFiles({ model: "gpt-5.4", input: [] })).toBe(false);
    expect(conversationCarriesUploadedFiles({})).toBe(false);
    expect(conversationCarriesUploadedFiles(undefined)).toBe(false);
    expect(conversationCarriesUploadedFiles("not a body")).toBe(false);
  });

  test("an empty file_ids array is not a file reference", () => {
    // fileIds is optional on the carrier type and always materialised as an array here, so the
    // emptiness test has to live in one place rather than being rewritten per caller.
    expect(conversationCarriesUploadedFiles({
      input: [{ type: "message", role: "user", file_ids: [] }],
    })).toBe(false);
  });

  test("the refusal message names the cause, the persistence, and both remedies", () => {
    // This refusal does not clear itself: the reference stays in history, so every later turn is
    // refused again. A caller told only that the reference is invalid would resend unchanged.
    expect(ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE).toContain("later turns will be refused");
    expect(ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE).toContain("re-upload the files");
    expect(ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE).toContain("start a new conversation");
    expect(ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE).toContain("no file was removed");
  });
});

/**
 * #4778 retention is only correct if it reaches EVERY resolution that can bind this
 * conversation to an account, because the sites do not fail the same way.
 *
 * The regular Responses path passes it at final auth. Native compact did not pass it at its
 * initial resolution, and the refusal it does carry runs only after a 429 -- by which time a
 * quota-driven rebind has already moved the conversation, so the guard declines a move that
 * happened one step earlier. Encrypted-agent-task recovery rebuilds the preview options from
 * scratch, and it does so against the DECRYPTED body, which is the first point at which a file
 * reference that was ciphertext-only becomes readable; a preview reconstructed without the bit
 * reports one account and final auth binds another.
 *
 * Asserted from source because the failure is an omitted option on a call, not a value any
 * reachable seam returns: a body-level test of the predicate (above) passes either way, and the
 * behavioural difference only appears against a live pool that is mid-rebind. The claim is
 * narrow and mechanical -- this exact call carries this exact expression -- so it fails on the
 * regression and on nothing else.
 */
describe("uploaded-file retention reaches every account resolution (#4778)", () => {
  const source = (...relative: string[]): string => readFileSync(repoPath(...relative), "utf8");

  /** The argument list of the single call whose head is `marker` (which must end at its own `(`). */
  function callArguments(src: string, marker: string): string {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    // A second occurrence would make the assertion below ambiguous about which call it read.
    expect(src.indexOf(marker, at + 1)).toBe(-1);
    const open = at + marker.length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error("unbalanced call arguments for: " + marker);
  }

  /** The object literal opened by `marker` (which must end at its own `{`). */
  function objectLiteral(src: string, marker: string): string {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    expect(src.indexOf(marker, at + 1)).toBe(-1);
    const open = at + marker.length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error("unbalanced object literal for: " + marker);
  }

  test("native compact passes the retention at its own initial resolution", () => {
    const compact = source("src", "server", "responses", "compact.ts");
    const initialAuth = callArguments(
      compact,
      "if (route.codexAccountMode) authCtx = await resolveCodexAuthContext(",
    );

    expect(initialAuth).toContain("retainAccountForUploadedFiles: conversationCarriesUploadedFiles(raw)");
  });

  test("the post-429 compact guard stays, because it answers a different question", () => {
    // The guard is not redundant with the retention above: retention declines a VOLUNTARY quota
    // move, while this refuses an alternate account after the issuing one has already rejected
    // the send. Removing either one reopens half of #4778.
    const compact = source("src", "server", "responses", "compact.ts");

    expect(compact).toContain("const alternate = conversationCarriesUploadedFiles(raw)");
  });

  test("both Responses previews answer the same question final auth does", () => {
    const prepare = source("src", "server", "responses", "request-prepare.ts");
    const retention = "retainAccountForUploadedFiles: conversationCarriesUploadedFiles(parsed._rawBody)";

    expect(objectLiteral(prepare, "const previewSelectionOptions = {")).toContain(retention);
    expect(objectLiteral(prepare, "const recoverySelectionOptions = {")).toContain(retention);
    expect(callArguments(prepare, "const finalAuth = await resolveResponsesCodexAuth("))
      .toContain("conversationCarriesUploadedFiles(parsed._rawBody)");
  });
});
