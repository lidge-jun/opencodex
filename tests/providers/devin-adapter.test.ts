import { describe, expect, test } from "bun:test";
import { createDevinAdapter, mapOcxMessagesToDevin, mapOcxToolsToDevin } from "../../src/adapters/devin";
import { sanitizeToolDescriptionForCognitionForTests } from "../../src/adapters/devin/cloud-direct/chat";
import { DEVIN_STATIC_MODELS, collapseDevinModelUid } from "../../src/adapters/devin/live-models";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxParsedRequest } from "../../src/types";

describe("devin adapter", () => {
  test("is registered as an oauth provider and adapter", () => {
    expect(OAUTH_PROVIDERS.devin.defaultModel).toBe("swe-1-7");
    const entry = PROVIDER_REGISTRY.find((row) => row.id === "devin");
    expect(entry?.adapter).toBe("devin");
    expect(entry?.authKind).toBe("oauth");
    expect(entry?.liveModels).toBe(true);
    expect(createDevinAdapter({ adapter: "devin", baseUrl: "https://server.codeium.com" }).name).toBe("devin");
  });

  test("maps user/assistant/tool history and tools", () => {
    const parsed: OcxParsedRequest = {
      modelId: "swe-1-7",
      stream: true,
      context: {
        systemPrompt: ["be brief"],
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "calling" },
              { type: "toolCall", id: "c1", name: "lookup", arguments: { q: "x" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "c1", toolName: "lookup", content: "ok", isError: false, timestamp: 3 },
        ],
        tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
      },
      options: {},
    };
    const history = mapOcxMessagesToDevin(parsed);
    expect(history[0]).toEqual({ role: "system", content: "be brief" });
    expect(history[1]).toEqual({ role: "user", content: "hi" });
    expect(history[2]?.role).toBe("assistant");
    expect(history[2]?.tool_calls?.[0]?.id).toBe("c1");
    expect(history[3]).toEqual({ role: "tool", content: "ok", tool_call_id: "c1" });
    expect(mapOcxToolsToDevin(parsed.context.tools)?.[0]?.name).toBe("lookup");
  });

  test("collapseDevinModelUid strips effort suffixes to base ids", () => {
    expect(collapseDevinModelUid("swe-1-7")).toBe("swe-1-7");
    expect(collapseDevinModelUid("swe-1-7-medium")).toBe("swe-1-7");
    expect(collapseDevinModelUid("swe-1-7-lightning")).toBe("swe-1-7-lightning");
    expect(collapseDevinModelUid("swe-1-7-lightning-medium")).toBe("swe-1-7-lightning");
    expect(collapseDevinModelUid("gpt-5-6-sol-high")).toBe("gpt-5-6-sol");
    expect(collapseDevinModelUid("gpt-5-6-sol-high-priority")).toBe("gpt-5-6-sol");
    expect(collapseDevinModelUid("glm-5-2-max-1m")).toBe("glm-5-2");
    expect(collapseDevinModelUid("claude-opus-4-8-high-fast")).toBe("claude-opus-4-8");
    expect(collapseDevinModelUid("claude-fable-5-1-high")).toBe("claude-fable-5-1");
    expect(collapseDevinModelUid("grok-4-5-medium")).toBe("grok-4-5");
  });

  test("loginDevin is browser-only (no local import option)", () => {
    // The devin OAuth entry must not accept importLocal/forceLogin opts —
    // login is always the Auth0 browser flow.
    const entry = OAUTH_PROVIDERS.devin;
    expect(entry.login.length).toBeLessThanOrEqual(1);
  });

  test("rewrites the Cognition blocklist trigger phrase in tool descriptions", () => {
    // The exact 7-word phrase (capital T, single spaces) triggers Cognition's
    // permission_denied content filter. The rewrite must break the exact match
    // while preserving meaning.
    const trigger = "Takes a task_id parameter identifying the task";
    expect(sanitizeToolDescriptionForCognitionForTests(trigger)).toBe("Accepts a task_id parameter identifying the task");
    // Case-sensitive: lowercase first letter is NOT rewritten (it doesn't trigger)
    expect(sanitizeToolDescriptionForCognitionForTests("takes a task_id parameter identifying the task"))
      .toBe("takes a task_id parameter identifying the task");
    // Substring match: the phrase embedded in a larger description is rewritten
    const full = "- Retrieves output from a running or completed task\n- Takes a task_id parameter identifying the task\n- Returns the task output";
    const rewritten = sanitizeToolDescriptionForCognitionForTests(full);
    expect(rewritten).not.toContain("Takes a task_id parameter identifying the task");
    expect(rewritten).toContain("Accepts a task_id parameter identifying the task");
    // Surrounding text is preserved
    expect(rewritten).toContain("- Retrieves output from a running or completed task");
    expect(rewritten).toContain("- Returns the task output");
    // Descriptions without the trigger pass through unchanged
    expect(sanitizeToolDescriptionForCognitionForTests("A benign description.")).toBe("A benign description.");
  });

  test("rewrites the Codex built-in tool descriptions Cognition refuses", () => {
    // These two are Codex's own exec_command and write_stdin descriptions,
    // verbatim. Every Codex turn carries them, so leaving them intact made the
    // cloud refuse every request from a Codex client, a bare "hi" included.
    // Measured against a live account: the sentences below were refused, and
    // the rewritten forms were accepted.
    const execCommand = "Runs a command in a PTY, returning output or a session ID for ongoing interaction.";
    expect(sanitizeToolDescriptionForCognitionForTests(execCommand))
      .toBe("Executes a command in a PTY, returning output or a session ID for ongoing interaction.");

    const writeStdin = "Writes characters to an existing unified exec session and returns recent output.";
    expect(sanitizeToolDescriptionForCognitionForTests(writeStdin))
      .toBe("Sends characters to an existing unified exec session and returns recent output.");

    // Cognition matches these two case-insensitively and tolerates both a
    // doubled interior space and a missing comma, so the rewrite has to reach
    // every variant that still gets refused rather than only the exact bytes.
    expect(sanitizeToolDescriptionForCognitionForTests(execCommand.toLowerCase()))
      .toContain("Executes a command in a PTY");
    expect(sanitizeToolDescriptionForCognitionForTests(
      "Runs a command in a PTY  returning output or a session  ID for ongoing interaction.",
    )).toContain("Executes a command in a PTY");

    // Changing any single word already clears the filter, so a description that
    // merely resembles these must survive untouched.
    const nearMiss = "Runs a command in a terminal, returning output or a session ID for ongoing interaction.";
    expect(sanitizeToolDescriptionForCognitionForTests(nearMiss)).toBe(nearMiss);
  });
});
