import { expect, test } from "bun:test";
import { createRegisteredAdapter } from "../src/adapters/registry";
import {
  createDisabledCursorTransport,
  type CursorTransport,
} from "../src/adapters/cursor/transport";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "cursor",
  baseUrl: "https://api2.cursor.sh",
};

const parsed: OcxParsedRequest = {
  modelId: "cursor/auto",
  context: {
    messages: [{ role: "user", content: "Edit the file.", timestamp: 0 }],
    tools: [{
      name: "exec",
      description: "Run JavaScript. declare const tools: { apply_patch(input: string): Promise<unknown>; };",
      parameters: {},
    }],
  },
  stream: true,
  options: {},
};

const PATCH_INPUT = [
  "*** Begin Patch",
  "*** Update File: src/example.ts",
  "@@",
  '-const value = "old";',
  '+const value = "new \\"quoted\\" \\\\ path 🧪";',
  "*** End Patch",
].join("\n");

function createApplyPatchCursorTransport(): CursorTransport {
  return {
    async *run() {
      const split = Math.floor(PATCH_INPUT.length / 2);
      yield { type: "tool_call_start", id: "call_patch", name: "apply_patch" };
      yield { type: "tool_call_delta", arguments: PATCH_INPUT.slice(0, split) };
      yield { type: "tool_call_delta", arguments: PATCH_INPUT.slice(split) };
      yield { type: "tool_call_end", id: "call_patch" };
      yield { type: "done" };
    },
    writeClient() {},
    close() {},
    requestCommitted() {
      return true;
    },
  };
}

test("Cursor registry construction reaches the real runTurn path with injected transport deps", async () => {
  const adapter = createRegisteredAdapter(provider, {
    cursorDeps: { createTransport: createDisabledCursorTransport },
  });
  const events: AdapterEvent[] = [];

  await adapter.runTurn?.(
    parsed,
    { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    event => events.push(event),
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    message: expect.stringContaining("explicit disabled Cursor transport was injected"),
  });
});

test("Cursor registry runTurn preserves exact freeform apply_patch input", async () => {
  const adapter = createRegisteredAdapter(provider, {
    cursorDeps: { createTransport: () => createApplyPatchCursorTransport() },
  });
  const events: AdapterEvent[] = [];

  await adapter.runTurn?.(
    structuredClone(parsed),
    { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    event => events.push(event),
  );

  expect(events.find(event => event.type === "tool_call_start")).toMatchObject({
    type: "tool_call_start",
    id: "call_patch",
    name: "apply_patch",
  });

  const restored = events
    .filter((event): event is Extract<AdapterEvent, { type: "tool_call_delta" }> =>
      event.type === "tool_call_delta")
    .map(event => event.arguments)
    .join("");

  expect(restored).toBe(PATCH_INPUT);
  expect(events.some(event => event.type === "tool_call_end")).toBe(true);
  expect(events.at(-1)?.type).toBe("done");
});
