import { expect, spyOn, test } from "bun:test";
import { modelSelectionGuidance, modelSelectionNextSteps } from "../../src/cli/model-selection-guidance";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";

test("registration guidance uses real CLI model commands and preserves exact listed IDs", () => {
  const next = modelSelectionNextSteps("openrouter");
  expect(next.commands).toEqual({
    list: "ocx models live --provider openrouter",
    enable: 'ocx models enable "<model-id-from-list>"',
    disable: 'ocx models disable "<model-id-from-list>"',
    enableNative: 'ocx models enable "<model-id-from-list>" --native',
    disableNative: 'ocx models disable "<model-id-from-list>" --native',
    enableAll: "ocx models provider openrouter on",
    disableAll: "ocx models provider openrouter off",
  });
  expect(next.requiresRunningProxy).toBe(true);
  const text = modelSelectionGuidance("openrouter").join("\n");
  expect(text).toContain("ocx start");
  expect(text).toContain("the provider stays active");
  expect(text).toContain("For rows marked native");
  expect(text).not.toContain("http");
});

test("generated native commands preserve qualified IDs through the actual CLI parser", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const writes: unknown[] = [];
  try {
    const commands = modelSelectionNextSteps("openai").commands;
    for (const command of [commands.enableNative, commands.disableNative]) {
      const [, , action, placeholder, ...flags] = command.split(" ");
      const selector = placeholder.replace('"<model-id-from-list>"', "team/gpt-future-unlisted");
      expect(await handleModelsRuntimeCommand(action, [selector, ...flags], {
        baseUrl: "http://model-guidance.test",
        fetchImpl: (async (_input, init) => {
          writes.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true });
        }) as typeof fetch,
      })).toBe(0);
    }
    expect(writes).toEqual([true, false].map(enabled => ({
      scope: "models", provider: "openai", enabled,
      targets: [{ id: "team/gpt-future-unlisted", native: true }],
    })));
  } finally { log.mockRestore(); }
});

test("Codex login aliases target the native provider and no-wait advice is explicitly future work", () => {
  for (const alias of ["codex", "chatgpt", "openai"]) {
    expect(modelSelectionNextSteps(alias).commands.list).toBe("ocx models live --provider openai");
  }
  expect(modelSelectionNextSteps("xai", true).afterLogin).toBe(true);
  expect(modelSelectionGuidance("xai", true)[0]).toContain("After login completes");
  expect(modelSelectionNextSteps("xai", true).commands.enable).not.toContain("xai/<");
});
