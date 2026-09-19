import { describe, expect, test } from "bun:test";
import { createRoutedCustomToolRestoreBlockRewrite } from "../../src/server/responses-custom-tool-repair";

function dataPayload(block: string): Record<string, unknown> {
  const line = block.split(/\r?\n/).find(entry => entry.startsWith("data:"));
  if (!line) throw new Error("missing SSE data line");
  return JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
}

function frame(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;
}

type StreamResult = {
  preview: string;
  doneInput: string;
  itemInput: string;
  terminalInput: string;
  identity: string[];
};

function restoreExecStream(argumentsText: string, fragments: readonly string[], tool = "exec"): StreamResult {
  const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set([tool]));
  try {
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: `fc_${tool}`,
        call_id: `call_${tool}`,
        name: tool,
        arguments: "",
        status: "in_progress",
      },
    }));
    const addedItem = dataPayload(added[0]!).item as Record<string, unknown>;
    let preview = "";
    for (const delta of fragments) {
      const blocks = rewrite(frame("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: `fc_${tool}`,
        delta,
      }));
      for (const block of blocks) {
        const payload = dataPayload(block);
        if (payload.type === "response.custom_tool_call_input.delta") {
          preview += String(payload.delta ?? "");
        }
      }
    }

    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: `fc_${tool}`,
      arguments: argumentsText,
    }));
    const itemDone = rewrite(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "function_call",
        id: `fc_${tool}`,
        call_id: `call_${tool}`,
        name: tool,
        arguments: argumentsText,
        status: "completed",
      },
    }));
    const terminal = rewrite(frame("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [{
          type: "function_call",
          id: `fc_${tool}`,
          call_id: `call_${tool}`,
          name: tool,
          arguments: argumentsText,
          status: "completed",
        }],
      },
    }));
    const donePayload = dataPayload(done[0]!);
    const doneItem = dataPayload(itemDone[0]!).item as Record<string, unknown>;
    const terminalResponse = dataPayload(terminal[0]!).response as { output: Array<Record<string, unknown>> };
    const terminalItem = terminalResponse.output[0] ?? {};
    return {
      preview,
      doneInput: String(donePayload.input),
      itemInput: String(doneItem.input),
      terminalInput: String(terminalItem.input),
      identity: [
        String(addedItem.id), String(donePayload.item_id),
        String(doneItem.id), String(doneItem.call_id), String(doneItem.name),
        String(terminalItem.id), String(terminalItem.call_id), String(terminalItem.name),
      ],
    };
  } finally {
    rewrite.dispose?.();
  }
}

describe("routed Responses custom-tool stream consistency", () => {
  test("holds a raw decorated apply_patch envelope at every split boundary", () => {
    // Completion rewrites a decorated envelope through `normalizeApplyPatchDelimiters`, so any
    // decorated marker published as a delta is a byte the authoritative item does not contain.
    // Raw input reaches this path only because ordinary raw bodies now stream; the older routed
    // decoder held every non-canonical shape and so never exposed this case.
    const argumentsText = "*** Begin Patch ***\n*** Update File: a.txt ***\n+one\n*** End Patch ***";
    for (let split = 0; split <= argumentsText.length; split++) {
      const result = restoreExecStream(
        argumentsText,
        [argumentsText.slice(0, split), argumentsText.slice(split)],
        "apply_patch",
      );
      expect(result.preview, `split ${split}`).toBe("");
      expect(result.doneInput, `split ${split}`).toBe(result.itemInput);
      expect(result.itemInput, `split ${split}`).toBe(result.terminalInput);
      // The authoritative input is the normalized envelope, not the decorated bytes.
      expect(result.doneInput, `split ${split}`).not.toBe(argumentsText);
      expect(result.doneInput, `split ${split}`).toContain("*** Begin Patch");
      expect(result.doneInput, `split ${split}`).not.toContain("*** Begin Patch ***");
    }
  });

  test("publishes nothing for a wrapper carrying a literal control character", () => {
    // A raw newline inside a JSON string makes the object unparseable, so completion keeps the
    // whole wrapper as the input. Previewing the decoded value first would be the same
    // disagreement a fenced body causes, reached through a different invalid spelling.
    const argumentsText = '{"input":"one\ntwo"}';
    const result = restoreExecStream(argumentsText, [argumentsText]);
    expect(result.preview).toBe("");
    expect(result.doneInput).toBe(argumentsText);
    expect(result.itemInput).toBe(argumentsText);
    expect(result.terminalInput).toBe(argumentsText);
  });

  test("holds a wrapped fenced exec body at every split boundary", () => {
    const argumentsText = JSON.stringify({ input: "```js\ntext(1)\n```" });
    for (let split = 0; split <= argumentsText.length; split++) {
      const result = restoreExecStream(argumentsText, [
        argumentsText.slice(0, split),
        argumentsText.slice(split),
      ]);
      // Completion strips the outer fence, so publishing even one fence byte would make
      // the preview impossible to reconcile with the authoritative item.
      expect(result.preview, `split ${split}`).toBe("");
      expect(result.doneInput, `split ${split}`).toBe("text(1)");
      expect(result.itemInput, `split ${split}`).toBe("text(1)");
      expect(result.terminalInput, `split ${split}`).toBe("text(1)");
      expect(result.identity, `split ${split}`).toEqual([
        "ctc_exec", "ctc_exec",
        "ctc_exec", "call_exec", "exec",
        "ctc_exec", "call_exec", "exec",
      ]);
    }
  });

  test("keeps ordinary raw exec input progressive", () => {
    const result = restoreExecStream("text(1)", ["te", "xt", "(1)"]);
    expect(result.preview).toBe("text(1)");
    expect(result.doneInput).toBe("text(1)");
    expect(result.itemInput).toBe("text(1)");
    expect(result.terminalInput).toBe("text(1)");
  });

  test.each([
    {
      label: "single fallback key",
      argumentsText: '{"code":"line\\nnext"}',
      fragments: ['{"code":"line', '\\nnext"}'],
      expected: "line\nnext",
    },
    {
      label: "whitespace around the canonical wrapper",
      argumentsText: ' \n { \t "input" \r : "spaced" }',
      fragments: [' \n { \t "in', 'put" \r : "spa', 'ced" }'],
      expected: "spaced",
    },
    {
      label: "JSON escapes",
      argumentsText: '{"input":"quote: \\\" slash: \\\\ tab: \\t"}',
      fragments: ['{"input":"quote: \\', '\" slash: \\\\ tab: \\', 't"}'],
      expected: 'quote: " slash: \\ tab: \t',
    },
    {
      label: "split surrogate pair",
      argumentsText: '{"input":"before \\uD83D\\uDE00 after"}',
      fragments: ['{"input":"before \\uD83D', '\\uDE00 after"}'],
      expected: "before 😀 after",
    },
  ])("keeps $label preview aligned with completion", ({ argumentsText, fragments, expected }) => {
    const result = restoreExecStream(argumentsText, fragments);
    expect(result.preview).toBe(expected);
    expect(result.doneInput).toBe(expected);
    expect(result.itemInput).toBe(expected);
    expect(result.terminalInput).toBe(expected);
  });

  test("documents the duplicate input-key preview limit", () => {
    const argumentsText = '{"input":"first","input":"second"}';
    const result = restoreExecStream(argumentsText, ['{"input":"first', '","input":"second"}']);
    // JSON.parse chooses the last duplicate key after the first value was already streamed.
    // Avoiding this mismatch would require buffering every valid canonical wrapper.
    expect(result.preview).toBe("first");
    expect(result.doneInput).toBe("second");
    expect(result.itemInput).toBe("second");
    expect(result.terminalInput).toBe("second");
  });

  test("documents the late-invalid-wrapper preview limit", () => {
    const argumentsText = '{"input":"safe\\q"}';
    const result = restoreExecStream(argumentsText, ['{"input":"safe', '\\q"}']);
    // Once a valid prefix is published there is no rewind. The undefined escape stops
    // further preview, while completion preserves the raw unparseable argument text.
    expect(result.preview).toBe("safe");
    expect(result.doneInput).toBe(argumentsText);
    expect(result.itemInput).toBe(argumentsText);
    expect(result.terminalInput).toBe(argumentsText);
  });
});
