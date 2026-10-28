import { describe, expect, test } from "bun:test";
import {
  createRoutedCustomToolRestoreBlockRewrite,
  RoutedCustomToolProgressError,
} from "../../src/server/responses-custom-tool-repair";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

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
  previews: string[];
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
    const previews: string[] = [];
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
      previews.push(preview);
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
      previews,
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
  test.each([
    ["late-invalid wrapper", ['{"input":"*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch', '\\q"}']],
    ["duplicate input key", ['{"input":"*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch",', '"input":"replacement"}']],
  ])("fails closed when canonical patch progress diverges at %s completion", (_label, fragments) => {
    const budget = createTestTranslatorBudget();
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["apply_patch"]), budget);
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: "", status: "in_progress" },
    }));
    const emitted = fragments.flatMap(delta => rewrite(frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_patch",
      delta,
    })));
    expect(emitted.some(block => dataPayload(block).type === "response.custom_tool_call_input.delta")).toBe(true);
    const authoritative = fragments.join("");
    expect(() => rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_patch",
      arguments: authoritative,
    }))).toThrow(RoutedCustomToolProgressError);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["item.done", "response.completed"])("fails before malformed patch %s without input.done", boundary => {
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(new Set(["apply_patch"]));
    const first = '{"input":"*** Begin Patch\\n*** Add File: a\\n+x\\n*** End Patch",';
    const second = '"input":"replacement"}';
    rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: "", status: "in_progress" },
    }));
    rewrite(frame("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_patch", delta: first }));
    rewrite(frame("response.function_call_arguments.delta", { output_index: 0, item_id: "fc_patch", delta: second }));
    const item = { type: "function_call", id: "fc_patch", call_id: "call_patch", name: "apply_patch", arguments: first + second, status: "completed" };
    const terminal = boundary === "item.done"
      ? frame("response.output_item.done", { output_index: 0, item })
      : frame("response.completed", { response: { status: "completed", output: [item] } });
    expect(() => rewrite(terminal)).toThrow(RoutedCustomToolProgressError);
  });

  test("publishes canonical operation bytes before the closing marker arrives", () => {
    const opening = "*** Begin Patch\n*** Update File: a.txt\n";
    const operation = "+one\n";
    const closing = "*** End Patch";
    const result = restoreExecStream(opening + operation + closing, [opening, operation, closing], "apply_patch");
    expect(result.previews).toEqual([opening, opening + operation, opening + operation + closing]);
    expect(result.previews[1]).not.toContain(closing);
  });

  test.each([
    ["LF operation", "*** Begin Patch\n*** Update File: a.txt\n+one\n*** End Patch"],
    ["CRLF operation", "*** Begin Patch\r\n*** Add File: a.txt\r\n+one\r\n*** End Patch\r\n"],
    ["no operation", "*** Begin Patch\ncontext only\n*** End Patch"],
  ])("streams canonical apply_patch at every split: %s", (_label, argumentsText) => {
    for (let split = 0; split <= argumentsText.length; split++) {
      const result = restoreExecStream(
        argumentsText,
        [argumentsText.slice(0, split), argumentsText.slice(split)],
        "apply_patch",
      );
      expect(result.preview, `split ${split}`).toBe(argumentsText);
      expect(result.doneInput, `split ${split}`).toBe(argumentsText);
      expect(result.itemInput, `split ${split}`).toBe(argumentsText);
      expect(result.terminalInput, `split ${split}`).toBe(argumentsText);
    }
  });

  test.each([
    ["LF", "*** Begin Patch\n*** Update File: a.txt\n+one\n*** End Patch ***\n", "*** Begin Patch\n*** Update File: a.txt\n+one\n*** End Patch\n"],
    ["CRLF", "*** Begin Patch\r\n*** Update File: a.txt\r\n+one\r\n*** End Patch ***\r\n", "*** Begin Patch\r\n*** Update File: a.txt\r\n+one\r\n*** End Patch\r\n"],
  ])("withholds only a rewritable terminal decoration at every split: %s", (_label, raw, normalized) => {
    for (let split = 0; split <= raw.length; split++) {
      const result = restoreExecStream(raw, [raw.slice(0, split), raw.slice(split)], "apply_patch");
      expect(result.preview, `split ${split}`).toBe(normalized.replace(/\r?\n$/, ""));
      expect(result.doneInput, `split ${split}`).toBe(normalized);
      expect(result.itemInput, `split ${split}`).toBe(normalized);
      expect(result.terminalInput, `split ${split}`).toBe(normalized);
    }
  });

  test.each([
    ["fenced", "```diff\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n```"],
    ["decorated opening", "*** Begin Patch ***\n*** Add File: a\n+x\n*** End Patch"],
  ])("keeps ambiguous %s input buffered", (_label, argumentsText) => {
    for (let split = 0; split <= argumentsText.length; split++) {
      const result = restoreExecStream(argumentsText, [argumentsText.slice(0, split), argumentsText.slice(split)], "apply_patch");
      expect(result.preview, `split ${split}`).toBe("");
    }
  });

  test("releases an interior decorated marker once following text proves it stable", () => {
    const input = "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch ***\ninterior";
    const result = restoreExecStream(input, Array.from(input));
    expect(result.preview).toBe(input);
    expect(result.doneInput).toBe(input);
  });

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
