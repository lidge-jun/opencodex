import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import {
  ADVISOR_SYSTEM_INSTRUCTION,
  advisorTranscript,
  buildAdvisorUserPrompt,
  formatAdvisorAdvice,
  formatAdvisorUnavailable,
} from "../../src/advisor/context";

function parsedWithHistory() {
  return parseRequest({
    model: "deepseek/deepseek-v4",
    stream: false,
    input: [
      { role: "user", content: "Fix the failing auth tests" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: JSON.stringify({ command: ["bun", "test", "tests/auth"] }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "3 tests failed: token refresh returns stale expiry",
      },
      { role: "assistant", content: [{ type: "output_text", text: "I suspect the refresh window." }] },
    ],
    tools: [
      { type: "function", name: "shell", description: "Run a shell command", parameters: { type: "object" } },
    ],
  });
}

describe("advisorTranscript", () => {
  test("renders user, tool calls, and tool results the worker produced", () => {
    const transcript = advisorTranscript(parsedWithHistory());
    expect(transcript).toContain("[user] Fix the failing auth tests");
    expect(transcript).toContain("[assistant tool call] shell(");
    expect(transcript).toContain("[tool result: shell] 3 tests failed");
    expect(transcript).toContain("[assistant] I suspect the refresh window.");
  });

  test("NEVER includes hidden chain-of-thought", () => {
    // The wire cannot express thinking parts; parsed requests carry them after a replay.
    const parsed = parsedWithHistory();
    parsed.context.messages = [
      ...parsed.context.messages,
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "SECRET CHAIN OF THOUGHT" }],
        timestamp: Date.now(),
      },
    ];
    const transcript = advisorTranscript(parsed);
    expect(transcript).not.toContain("SECRET CHAIN OF THOUGHT");
  });

  test("oversize tool output is clipped with an explicit truncation marker", () => {
    const parsed = parseRequest({
      model: "deepseek/deepseek-v4",
      stream: false,
      input: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "c", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c", output: "x".repeat(10_000) },
      ],
    });
    const transcript = advisorTranscript(parsed);
    expect(transcript.length).toBeLessThan(10_000);
    expect(transcript).toContain("[truncated");
  });
});

describe("buildAdvisorUserPrompt", () => {
  test("carries worker identity, advisor identity, task, tools, and transcript", () => {
    const parsed = parsedWithHistory();
    const prompt = buildAdvisorUserPrompt({
      parsed,
      workerIdentity: "deepseek-v4 (provider deepseek)",
      advisorModel: "gpt-6-astra",
      reason: "preflight",
    });
    expect(prompt).toContain("deepseek-v4 (provider deepseek)");
    expect(prompt).toContain("gpt-6-astra");
    expect(prompt).toContain("Fix the failing auth tests");
    expect(prompt).toContain("shell");
    expect(prompt).toContain("automatically before the worker's first substantive turn");
  });

  test("manual reason names the explicit request", () => {
    const prompt = buildAdvisorUserPrompt({
      parsed: parsedWithHistory(),
      workerIdentity: "w",
      advisorModel: "a",
      reason: "manual",
      question: "Should I rewrite the token store?",
    });
    expect(prompt).toContain("at the worker's explicit request");
    expect(prompt).toContain("Should I rewrite the token store?");
  });

  test("system instruction positions the advisor as advice-only", () => {
    expect(ADVISOR_SYSTEM_INSTRUCTION).toContain("CANNOT execute anything");
    expect(ADVISOR_SYSTEM_INSTRUCTION).not.toContain("You are the worker");
  });
});

describe("advice formatting", () => {
  test("advice is wrapped in the identifiable marker and names the advisor", () => {
    const formatted = formatAdvisorAdvice({ advisorModel: "gpt-6-astra", reason: "preflight", advice: "Do X first." });
    expect(formatted).toContain("<opencodex_advisor>");
    expect(formatted).toContain("</opencodex_advisor>");
    expect(formatted).toContain("advisor model: gpt-6-astra");
    expect(formatted).toContain("consultation reason: preflight");
    expect(formatted).toContain("Do X first.");
  });

  test("unavailable context is non-misleading and bounded", () => {
    const formatted = formatAdvisorUnavailable("preflight", "advisor HTTP 502: upstream exploded");
    expect(formatted).toContain("<opencodex_advisor>");
    expect(formatted).toContain("currently unavailable");
    expect(formatted).toContain("This is not advice.");
  });
});
