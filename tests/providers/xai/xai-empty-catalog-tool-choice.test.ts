import { describe, expect, test } from "bun:test";
import { normalizeXaiResponsesWebSearch } from "../../../src/adapters/xai-web-search";
import {
  createGrokResponsesSparseTerminalBlockRewrite,
  GROK_FORBIDDEN_TOOL_CALL_REASON,
  GROK_REFUSED_TERMINAL_EVENT_TYPE,
  forbiddenToolCallMessage,
} from "../../../src/server/grok-responses-snapshot-repair";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const XAI_PROVIDER = { baseUrl: "https://api.x.ai/v1" };

function normalize(body: Record<string, unknown>): Record<string, unknown> {
  return normalizeXaiResponsesWebSearch(body, XAI_PROVIDER) as Record<string, unknown>;
}

const CALL_ITEM: Record<string, unknown> = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "apply_patch",
  arguments: "{}",
};

const MESSAGE_ITEM: Record<string, unknown> = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "there is nothing to call here", annotations: [] }],
};

function dataBlock(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

/** Replay a sparse Grok stream against one outbound body and return the terminal it publishes. */
function reconstructTerminal(outboundBody: unknown): Record<string, unknown> {
  const rewrite = createGrokResponsesSparseTerminalBlockRewrite(
    createTestTranslatorBudget(),
    outboundBody,
  );
  rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: CALL_ITEM }));
  rewrite(dataBlock({ type: "response.output_item.done", output_index: 1, item: MESSAGE_ITEM }));
  const out = rewrite(
    `event: response.completed\n${dataBlock({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [] },
    })}`,
  );
  expect(out).toHaveLength(1);
  const data = out[0]!.split(/\r?\n/)
    .filter(line => line.startsWith("data: "))
    .map(line => line.slice("data: ".length))
    .join("");
  return JSON.parse(data) as Record<string, unknown>;
}

describe("xAI Responses selectors after tool normalization", () => {
  test("a catalog emptied by normalization drops the selector that has nothing left to select", () => {
    // The cached-only declaration is omitted above rather than widened to live search, which
    // leaves the request selecting from a catalog it no longer has; xAI answers 400.
    const body = normalize({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{ type: "web_search", external_web_access: false }],
      tool_choice: "auto",
    });

    expect(Object.hasOwn(body, "tools")).toBe(false);
    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
  });

  test("a prohibition the omission would erase is restated as the explicit empty catalog", () => {
    // Normalization turns a selector for the removed search into "none", and the request then
    // says nothing else about what this turn may contain. Omitting that word for the wire without
    // restating it would leave a body that authorizes more than the caller did.
    const body = normalize({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{ type: "web_search", external_web_access: false }],
      tool_choice: { type: "web_search" },
    });

    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
    expect(body.tools).toEqual([]);
  });

  test("a caller's own prohibition survives an omission it never asked for", () => {
    const body = normalize({ model: "grok-4.6", input: "hi", tool_choice: "none" });

    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
    expect(body.tools).toEqual([]);
  });

  test("omitting auto invents no catalog the caller never declared", () => {
    // An absent catalog states no boundary, and a passthrough request may legitimately omit
    // tools and still receive a call its client understands.
    const body = normalize({ model: "grok-4.6", input: "hi", tool_choice: "auto" });

    expect(Object.hasOwn(body, "tool_choice")).toBe(false);
    expect(Object.hasOwn(body, "tools")).toBe(false);
  });

  test("the restated catalog still refuses a forbidden call in a reconstructed terminal", () => {
    // The wire-compatibility omission and the reconstruction boundary meet here: the repair reads
    // the final outbound body, so a request that forbade every client call must still refuse one
    // that arrives in a sparse stream, and must keep the assistant text that arrived beside it.
    const terminal = reconstructTerminal(normalize({
      model: "grok-4.6",
      input: "latest xAI news",
      tools: [{ type: "web_search", external_web_access: false }],
      tool_choice: { type: "web_search" },
    }));
    const response = terminal.response as Record<string, unknown>;

    expect(terminal.type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    expect(response.output).toEqual([MESSAGE_ITEM]);
    expect(response.incomplete_details).toEqual({
      reason: GROK_FORBIDDEN_TOOL_CALL_REASON,
      message: forbiddenToolCallMessage(CALL_ITEM.name as string),
    });
  });

  test("an explicitly empty catalog carries no selector either", () => {
    for (const choice of ["auto", "none"]) {
      const body = normalize({ model: "grok-4.6", input: "hi", tools: [], tool_choice: choice });
      expect(Object.hasOwn(body, "tool_choice")).toBe(false);
    }
  });

  test("a selector that still has a tool to select is left alone", () => {
    const body = normalize({
      model: "grok-4.6",
      input: "hi",
      tools: [{ type: "function", name: "read_file" }],
      tool_choice: "auto",
    });

    expect(body.tool_choice).toBe("auto");
  });

  test("a forced function selector survives an empty catalog as a client input error", () => {
    // Dropping it would silently turn "call this tool" into "answer however you like"; the
    // request-build path answers a selector this proxy cannot honor with a 400 instead.
    const body = normalize({
      model: "grok-4.6",
      input: "hi",
      tools: [],
      tool_choice: { type: "function", name: "read_file" },
    });

    expect(body.tool_choice).toEqual({ type: "function", name: "read_file" });
  });
});
