import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { chatCompletionsToResponsesBody, ChatCompletionsRequestError } from "../../src/chat/inbound";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { inlineDocumentDataUrl, inlineDocumentMarker, inlineDocumentFromDataUrl, isInlineDocumentDataUrl } from "../../src/responses/inline-document";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

/**
 * #5212. Both inbound parsers reduced an attachment to its name before any adapter ran, so no
 * adapter could forward one even to a target that has a representation for it. The caller could
 * not tell "the model read the document" from "the model was told a document existed", which is
 * why every assertion here reads the outbound request rather than the response.
 */

const PDF_BYTES = "JVBERi0xLjQK";
// Derived, not restated: the wire spelling is the module's to define, and a test that repeats it
// fails for the wrong reason the next time it changes.
const PDF_DATA_URL = inlineDocumentDataUrl({
  type: "document",
  text: "",
  mediaType: "application/pdf",
  data: PDF_BYTES,
});

const chatProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://gateway.example.internal/v1",
  apiKey: "k",
  // The case below asserts that a document survives on a `developer` turn, so it needs the
  // role to reach the wire. That role folds to `system` unless a destination records that it
  // accepts it, so the destination records it here; the document contract is what is under
  // test, not the role decision.
  foldDeveloperRoleToSystem: false,
};
const anthropicProvider = {
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-x",
  authMode: "apiKey",
} as unknown as OcxProviderConfig;

function chatRequest(part: unknown): Record<string, unknown> {
  return {
    model: "mock/test-model",
    messages: [{ role: "user", content: [part] }],
  };
}

function claudeRequest(block: unknown): Record<string, unknown> {
  return {
    model: "anthropic/claude-sonnet-4.5",
    max_tokens: 64,
    messages: [{ role: "user", content: [block] }],
  };
}

const DOCUMENT_BLOCK = {
  type: "document",
  title: "spec",
  source: { type: "base64", media_type: "application/pdf", data: PDF_BYTES },
};

/** The user turn's content, which `inputContentParts` collapses to a string for lone text. */
function parsedContent(body: Record<string, unknown>): unknown {
  const parsed = parseRequest(body as never);
  const user = parsed.context.messages.find(message => message.role === "user");
  return user!.content;
}

describe("inline document bytes survive the inbound parse", () => {
  test.each(["A", "A=", "AA=", "AAA=="])("malformed base64 quantum %s is refused before translation", (payload) => {
    const url = `data:application/pdf;base64,${payload}`;
    expect(isInlineDocumentDataUrl(url)).toBe(false);
    expect(inlineDocumentFromDataUrl(url, "doc.pdf")).toBeUndefined();
    expect(() => chatCompletionsToResponsesBody(chatRequest({
      type: "file", file: { filename: "doc.pdf", file_data: url },
    }))).toThrow(ChatCompletionsRequestError);
  });

  test.each(["AA", "AAA", "AA==", "AAA=", "AAAA"])("valid padded or unpadded bytes %s survive unchanged", (payload) => {
    const url = `data:application/pdf;base64,${payload}`;
    expect(isInlineDocumentDataUrl(url)).toBe(true);
    const content = parsedContent(chatCompletionsToResponsesBody(chatRequest({
      type: "file", file: { filename: "doc.pdf", file_data: url },
    })));
    expect(content).toEqual([expect.objectContaining({ type: "document", data: payload })]);
  });

  test("a Chat file part becomes a document carrying its bytes", () => {
    const content = parsedContent(chatCompletionsToResponsesBody(chatRequest({
      type: "file",
      file: { filename: "doc.pdf", file_data: PDF_DATA_URL },
    })));
    expect(content).toEqual([
      {
        type: "document",
        text: inlineDocumentMarker("doc.pdf"),
        mediaType: "application/pdf",
        data: PDF_BYTES,
        filename: "doc.pdf",
      },
    ]);
  });

  test("an Anthropic base64 document keeps its bytes and its title", () => {
    const content = parsedContent(anthropicToResponsesBody(claudeRequest(DOCUMENT_BLOCK)));
    expect(content).toEqual([
      {
        type: "document",
        text: inlineDocumentMarker("spec"),
        mediaType: "application/pdf",
        data: PDF_BYTES,
        filename: "spec",
      },
    ]);
  });

  test("a document with no usable bytes still reduces to the marker", () => {
    const content = parsedContent(anthropicToResponsesBody(claudeRequest({
      type: "document",
      title: "remote",
      source: { type: "url", url: "https://example.com/doc.pdf" },
    })));
    expect(content).toBe(inlineDocumentMarker("remote"));
  });

  test("a reference with no payload is still refused rather than answered", () => {
    expect(() => chatCompletionsToResponsesBody(chatRequest({
      type: "file",
      file: { file_id: "file-123" },
    }))).toThrow(ChatCompletionsRequestError);
    expect(() => chatCompletionsToResponsesBody(chatRequest({
      type: "input_audio",
      input_audio: { data: "AA==", format: "wav" },
    }))).toThrow(ChatCompletionsRequestError);
  });
});

describe("inline document bytes reach a wire that can hold them", () => {
  function chatOutbound(body: Record<string, unknown>): Record<string, unknown> {
    const parsed = parseRequest(body as never) as OcxParsedRequest;
    return JSON.parse(createOpenAIChatAdapter(chatProvider).buildRequest(parsed).body) as Record<string, unknown>;
  }

  test("an Anthropic document reaches the OpenAI Chat wire as a file part", () => {
    const outbound = chatOutbound(anthropicToResponsesBody(claudeRequest(DOCUMENT_BLOCK)));
    const messages = outbound.messages as Array<{ role: string; content: unknown }>;
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "file", file: { file_data: PDF_DATA_URL, filename: "spec" } }],
    });
  });

  test("a Chat file part reaches the Anthropic wire as a document block", async () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody(chatRequest({
      type: "file",
      file: { filename: "doc.pdf", file_data: PDF_DATA_URL },
    })) as never) as OcxParsedRequest;
    const { body } = await createAnthropicAdapter(anthropicProvider).buildRequest(parsed);
    const sent = JSON.parse(typeof body === "string" ? body : JSON.stringify(body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(sent.messages.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: PDF_BYTES },
        title: "doc.pdf",
      }],
    });
  });

  test("a document beside text keeps both on the Chat wire", () => {
    const outbound = chatOutbound(anthropicToResponsesBody({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "Summarize it." }, DOCUMENT_BLOCK] }],
    }));
    const messages = outbound.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages.at(-1)!.content).toEqual([
      { type: "text", text: "Summarize it." },
      { type: "file", file: { file_data: PDF_DATA_URL, filename: "spec" } },
    ]);
  });

  test("a developer turn carrying a document keeps its role", () => {
    const parsed = {
      modelId: "local-model",
      context: {
        messages: [{
          role: "developer",
          content: [{ type: "document", text: inlineDocumentMarker("spec"), mediaType: "application/pdf", data: PDF_BYTES, filename: "spec" }],
          timestamp: 0,
        }],
      },
      stream: false,
      options: {},
    } as unknown as OcxParsedRequest;
    const outbound = JSON.parse(createOpenAIChatAdapter(chatProvider).buildRequest(parsed).body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(outbound.messages).toEqual([{
      role: "developer",
      content: [{ type: "file", file: { file_data: PDF_DATA_URL, filename: "spec" } }],
    }]);
  });
});
