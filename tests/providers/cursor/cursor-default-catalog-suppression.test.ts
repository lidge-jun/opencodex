import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../../../src/adapters/cursor/request-builder";
import type { OcxParsedRequest } from "../../../src/types/request";

function parsedRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "cursor/grok-4.6",
    context: {
      systemPrompt: [],
      messages: [{ role: "user", content: "hi" }],
      tools: undefined,
    },
    options: {},
    ...overrides,
  } as OcxParsedRequest;
}

const CALLER_TOOL = {
  name: "get_weather",
  description: "d",
  parameters: { type: "object", properties: {} },
} as const;

describe("cursor default-catalog suppression (preamble floor)", () => {
  test("bare request with no tools and no thread identity sets the flag", () => {
    const request = createCursorRequest(parsedRequest());
    expect(request.suppressDefaultCursorToolCatalog).toBe(true);
  });

  test("_clientThreadId identity keeps the default catalog (flag unset)", () => {
    const request = createCursorRequest(parsedRequest({ _clientThreadId: "thread-1" } as Partial<OcxParsedRequest>));
    expect(request.suppressDefaultCursorToolCatalog).toBeUndefined();
  });

  test("_cursorClientThreadId identity keeps the default catalog (flag unset)", () => {
    const request = createCursorRequest(parsedRequest({ _cursorClientThreadId: "app:x" } as Partial<OcxParsedRequest>));
    expect(request.suppressDefaultCursorToolCatalog).toBeUndefined();
  });

  test("caller-supplied tools never set the flag", () => {
    const request = createCursorRequest(parsedRequest({
      context: { systemPrompt: [], messages: [{ role: "user", content: "hi" }], tools: [CALLER_TOOL] },
    } as Partial<OcxParsedRequest>));
    expect(request.suppressDefaultCursorToolCatalog).toBeUndefined();
    expect(request.tools?.length).toBe(1);
  });
});
