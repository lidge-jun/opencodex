import { expect, test } from "bun:test";
import { createRegisteredAdapter } from "../src/adapters/registry";
import { createDisabledCursorTransport } from "../src/adapters/cursor/transport";
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
    message: expect.stringContaining("explicit disabled Cursor transport"),
  });
});
