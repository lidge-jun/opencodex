import { describe, expect, test } from "bun:test";
import {
  createGrokResponsesSparseTerminalBlockRewrite,
  forbiddenToolCallMessage,
  GROK_FORBIDDEN_TOOL_CALL_REASON,
  GROK_REFUSED_TERMINAL_EVENT_TYPE,
} from "../../src/server/grok-responses-snapshot-repair";
import { rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";
import { rewriteRoutedNamespaceToolsForUpstream } from "../../src/responses/namespace-tool-compat";
import type { RequestToolScopeCorrespondence } from "../../src/server/responses-request-tool-scope";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function dataBlock(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function terminalBlock(payload: unknown): string {
  return `event: response.completed\ndata: ${JSON.stringify(payload)}`;
}

function payloadOf(block: string): Record<string, unknown> {
  const data = block.split(/\r?\n/)
    .filter(line => line.startsWith("data: "))
    .map(line => line.slice("data: ".length))
    .join("");
  return JSON.parse(data) as Record<string, unknown>;
}

function eventNameOf(block: string): string | undefined {
  const line = block.split(/\r?\n/).find(candidate => candidate.startsWith("event: "));
  return line === undefined ? undefined : line.slice("event: ".length);
}

function responseOf(block: string): Record<string, unknown> {
  return payloadOf(block).response as Record<string, unknown>;
}

const MESSAGE_ITEM: Record<string, unknown> = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "here is the answer", annotations: [] }],
};

const CALL_ITEM: Record<string, unknown> = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "apply_patch",
  arguments: "{}",
};

const SPARSE_TERMINAL = {
  type: "response.completed",
  response: { id: "resp_1", status: "completed", output: [] },
};

function relay(
  outboundBody: unknown,
  items: readonly { index: number; item: Record<string, unknown> }[],
  correspondence?: RequestToolScopeCorrespondence,
): { terminal: string; forwarded: string[] } {
  const rewrite = createGrokResponsesSparseTerminalBlockRewrite(
    createTestTranslatorBudget(),
    outboundBody,
    correspondence,
  );
  const forwarded: string[] = [];
  for (const { index, item } of items) {
    forwarded.push(
      ...rewrite(dataBlock({ type: "response.output_item.done", output_index: index, item })),
    );
  }
  const out = rewrite(terminalBlock(SPARSE_TERMINAL));
  expect(out).toHaveLength(1);
  return { terminal: out[0]!, forwarded };
}

function ordered(...items: Record<string, unknown>[]): { index: number; item: Record<string, unknown> }[] {
  return items.map((item, index) => ({ index, item }));
}

describe("Grok sparse terminal reconstruction honours the request's tool selection", () => {
  test("a request that selected no tools keeps the text and refuses the call explicitly", () => {
    const { terminal } = relay(
      { model: "grok-4.6", tools: [{ type: "function", name: "apply_patch" }], tool_choice: "none" },
      ordered(CALL_ITEM, MESSAGE_ITEM),
    );

    expect(payloadOf(terminal).type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    expect(eventNameOf(terminal)).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    const response = responseOf(terminal);
    expect(response.status).toBe("incomplete");
    // The forbidden call is the only casualty; the assistant text that arrived with it survives.
    expect(response.output).toEqual([MESSAGE_ITEM]);
    expect(response.incomplete_details).toEqual({
      reason: GROK_FORBIDDEN_TOOL_CALL_REASON,
      message: forbiddenToolCallMessage(CALL_ITEM.name as string),
    });
  });

  test("a refusal with nothing else to publish is still explicit, not an empty clean finish", () => {
    const { terminal } = relay(
      { model: "grok-4.6", tools: [{ type: "function", name: "apply_patch" }], tool_choice: "none" },
      ordered(CALL_ITEM),
    );

    expect(payloadOf(terminal).type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    expect(responseOf(terminal).output).toEqual([]);
  });

  test("the raw stream is forwarded untouched; only the reconstructed terminal is bounded", () => {
    const { forwarded } = relay(
      { model: "grok-4.6", tools: [{ type: "function", name: "apply_patch" }], tool_choice: "none" },
      ordered(CALL_ITEM),
    );

    expect(forwarded).toEqual([
      dataBlock({ type: "response.output_item.done", output_index: 0, item: CALL_ITEM }),
    ]);
  });

  test("a selection that permits the call reconstructs it unchanged", () => {
    const { terminal } = relay(
      {
        model: "grok-4.6",
        tools: [{ type: "function", name: "apply_patch" }],
        tool_choice: { type: "function", name: "apply_patch" },
      },
      ordered(CALL_ITEM, MESSAGE_ITEM),
    );

    expect(payloadOf(terminal).type).toBe("response.completed");
    expect(responseOf(terminal).output).toEqual([CALL_ITEM, MESSAGE_ITEM]);
  });

  test("a forced selector for a different tool refuses the call it did not select", () => {
    const { terminal } = relay(
      {
        model: "grok-4.6",
        tools: [{ type: "function", name: "apply_patch" }, { type: "function", name: "read_file" }],
        tool_choice: { type: "function", name: "read_file" },
      },
      ordered(CALL_ITEM, MESSAGE_ITEM),
    );

    expect(payloadOf(terminal).type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    expect(responseOf(terminal).output).toEqual([MESSAGE_ITEM]);
  });

  test("an allow-list admits a listed tool and refuses an unlisted one", () => {
    const body = {
      model: "grok-4.6",
      tools: [{ type: "function", name: "apply_patch" }, { type: "function", name: "read_file" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "function", name: "read_file" }],
      },
    };
    const listed: Record<string, unknown> = { ...CALL_ITEM, name: "read_file" };

    expect(responseOf(relay(body, ordered(listed)).terminal).output).toEqual([listed]);
    expect(payloadOf(relay(body, ordered(CALL_ITEM, MESSAGE_ITEM)).terminal).type)
      .toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
  });

  test("a namespaced call matches the selector under either flattened spelling", () => {
    const namespaced: Record<string, unknown> = { ...CALL_ITEM, name: "search", namespace: "docs" };
    for (const selected of ["docs__search", "docs.search"]) {
      const rewritten = rewriteRoutedNamespaceToolsForUpstream({
        model: "grok-4.6",
        tools: [{ type: "namespace", name: "docs", tools: [{ type: "function", name: "search" }] }],
        tool_choice: { type: "function", name: selected },
      });
      const { terminal } = relay(
        rewritten.body,
        ordered(namespaced),
        { routedNamespaceToolAliases: rewritten.aliases },
      );
      expect(responseOf(terminal).output).toEqual([namespaced]);
    }
  });

  test("a qualified selector never admits another namespace with the same basename", () => {
    const rewritten = rewriteRoutedNamespaceToolsForUpstream({
      model: "grok-4.6",
      tools: [
        { type: "namespace", name: "alpha", tools: [{ type: "function", name: "lookup" }] },
        { type: "namespace", name: "beta", tools: [{ type: "function", name: "lookup" }] },
      ],
      tool_choice: { type: "function", name: "lookup", namespace: "alpha" },
    });
    const alpha = { ...CALL_ITEM, name: "lookup", namespace: "alpha" };
    const beta = { ...CALL_ITEM, name: "lookup", namespace: "beta" };
    const correspondence = { routedNamespaceToolAliases: rewritten.aliases };

    expect(responseOf(relay(rewritten.body, ordered(alpha), correspondence).terminal).output)
      .toEqual([alpha]);
    expect(payloadOf(relay(rewritten.body, ordered(beta), correspondence).terminal).type)
      .toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
  });

  test("same-named function and custom identities do not match by coincidence", () => {
    const clientBody = {
      model: "grok-4.6",
      tools: [{ type: "function", name: "lookup" }, { type: "custom", name: "lookup" }],
      tool_choice: { type: "function", name: "lookup" },
    };
    const converted = rewriteRoutedCustomToolsForUpstream(clientBody, false);
    const custom = {
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_1",
      name: "lookup",
      input: "query",
    };

    expect(payloadOf(relay(converted.body, ordered(custom), {
      clientToolAuthorizationBody: clientBody,
      convertedRoutedCustomToolNames: converted.names,
    }).terminal).type)
      .toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
  });

  test("a request-verified custom-to-function conversion remains authorized", () => {
    const clientBody = {
      model: "grok-4.6",
      tools: [{ type: "custom", name: "shell", description: "run", format: { type: "text" } }],
      tool_choice: { type: "custom", name: "shell" },
    };
    const converted = rewriteRoutedCustomToolsForUpstream(clientBody, false);
    const namespaced = rewriteRoutedNamespaceToolsForUpstream(converted.body, converted.names);
    const custom = {
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_1",
      name: "shell",
      input: "echo ok",
    };

    const { terminal } = relay(namespaced.body, ordered(custom, MESSAGE_ITEM), {
      clientToolAuthorizationBody: clientBody,
      routedNamespaceToolAliases: namespaced.aliases,
      convertedRoutedCustomToolNames: converted.names,
    });
    expect(responseOf(terminal).output).toEqual([custom, MESSAGE_ITEM]);
  });

  test("malformed narrowing selectors fail closed instead of becoming unrestricted", () => {
    for (const toolChoice of [
      { type: "function", name: "apply_patch", namespace: 42 },
      { type: "allowed_tools", mode: "auto", tools: "apply_patch" },
    ]) {
      const { terminal } = relay(
        {
          model: "grok-4.6",
          tools: [{ type: "function", name: "apply_patch" }],
          tool_choice: toolChoice,
        },
        ordered(CALL_ITEM),
      );
      expect(payloadOf(terminal).type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
    }
  });

  test("a catalog emptied by normalization admits no client call, with or without a selector", () => {
    for (const body of [
      { model: "grok-4.6", tools: [] },
      { model: "grok-4.6", tools: [], tool_choice: "auto" },
      { model: "grok-4.6", tools: [{ type: "web_search" }], tool_choice: "auto" },
    ]) {
      const { terminal } = relay(body, ordered(CALL_ITEM, MESSAGE_ITEM));
      expect(payloadOf(terminal).type).toBe(GROK_REFUSED_TERMINAL_EVENT_TYPE);
      expect(responseOf(terminal).output).toEqual([MESSAGE_ITEM]);
    }
  });

  test("a request that declares no catalog at all keeps its existing reconstruction", () => {
    // A passthrough request may legitimately omit `tools` and still receive a call the client
    // understands, so an absent catalog states no boundary for this repair to enforce.
    const { terminal } = relay({ model: "grok-4.6", input: [] }, ordered(CALL_ITEM, MESSAGE_ITEM));

    expect(payloadOf(terminal).type).toBe("response.completed");
    expect(responseOf(terminal).output).toEqual([CALL_ITEM, MESSAGE_ITEM]);
  });

  test("a selection with nothing to refuse reconstructs the ordinary terminal", () => {
    const { terminal } = relay(
      { model: "grok-4.6", tools: [{ type: "function", name: "apply_patch" }], tool_choice: "none" },
      ordered(MESSAGE_ITEM),
    );

    expect(payloadOf(terminal).type).toBe("response.completed");
    expect(responseOf(terminal).output).toEqual([MESSAGE_ITEM]);
  });

  test("a withheld index never fills a gap the stream actually left", () => {
    const { terminal } = relay(
      { model: "grok-4.6", tools: [{ type: "function", name: "apply_patch" }], tool_choice: "none" },
      [{ index: 0, item: CALL_ITEM }, { index: 2, item: MESSAGE_ITEM }],
    );

    expect(payloadOf(terminal).type).toBe("response.completed");
    expect(responseOf(terminal).output).toEqual([]);
  });

  test("refusing a call releases every retained byte", () => {
    const budget = createTestTranslatorBudget();
    const rewrite = createGrokResponsesSparseTerminalBlockRewrite(budget, {
      model: "grok-4.6",
      tools: [{ type: "function", name: "apply_patch" }],
      tool_choice: "none",
    });
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 0, item: CALL_ITEM }));
    rewrite(dataBlock({ type: "response.output_item.done", output_index: 1, item: MESSAGE_ITEM }));
    rewrite(terminalBlock(SPARSE_TERMINAL));

    expect(budget.snapshot().currentBytes).toBe(0);
    rewrite.dispose?.();
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});
