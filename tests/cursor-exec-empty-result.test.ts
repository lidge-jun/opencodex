import { describe, expect, test } from "bun:test";
import { normalizeCursorToolResultText } from "../src/adapters/cursor/tool-result-normalize";

describe("codex exec bridge empty-result normalization (devlog 260826 gap-7)", () => {
  test("empty exec cell output becomes explanatory text, not an error", () => {
    const out = normalizeCursorToolResultText("Script completed\nWall time 0.1 seconds\nOutput:\n", { toolName: "exec" });
    expect(out.changed).toBe(true);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("NOT lost context");
    expect(out.text).toContain("text(...)");
  });

  test("mcp display alias names route the same way", () => {
    const out = normalizeCursorToolResultText("", { toolName: "mcp_opencodex-responses_exec" });
    expect(out.changed).toBe(true);
    expect(out.text).toContain("empty output");
  });

  test("shell_command empty output routes too", () => {
    const out = normalizeCursorToolResultText("<empty>", { toolName: "shell_command" });
    expect(out.changed).toBe(true);
  });

  test("codex CLI native shell names route too (multi-round restart loop, QA round 2)", () => {
    for (const name of ["shell", "local_shell", "container.exec"]) {
      const out = normalizeCursorToolResultText("", { toolName: name });
      expect(out.changed).toBe(true);
      expect(out.isError).toBe(false);
    }
  });

  // A failed wrapper is empty but not a success: reporting it as an empty success would erase the
  // only failure signal. Reachable with isError: false through Responses history.
  test("a failed exec wrapper keeps failure guidance, not empty-success text", () => {
    const out = normalizeCursorToolResultText("Script failed\nWall time 0.1 seconds\nOutput:\n", { toolName: "exec", isError: false });
    expect(out.changed).toBe(true);
    expect(out.text).toContain("exec failed");
    expect(out.text).not.toContain("NOT lost context");
    expect(out.text).not.toContain("Do not re-run");
  });

  test("non-empty exec output passes through byte-identical", () => {
    const out = normalizeCursorToolResultText("Output:\nhello", { toolName: "exec" });
    expect(out.changed).toBe(false);
    expect(out.text).toBe("Output:\nhello");
  });

  test("a malformed failed wrapper is classified in linear time", () => {
    // The previous regex used overlapping whitespace quantifiers, so an input that never
    // completes the match made the engine try every split between them. Measured on Bun
    // 1.4 the same shape took ~820ms at 30k and ~3.1s at 60k — quadratic growth on text
    // that arrives inside a tool result. 500ms is far above the linear scan's real cost
    // (~0.02ms) and far below the old behavior, so it fails loudly if backtracking returns
    // without being tight enough to flake on a loaded worker.
    const malformed = `Script failed${" ".repeat(60_000)}\nY`;
    const startedAt = performance.now();
    const out = normalizeCursorToolResultText(malformed, { toolName: "exec", isError: false });
    const elapsedMs = performance.now() - startedAt;

    expect(out.changed).toBe(false);
    expect(out.text).toBe(malformed);
    expect(elapsedMs).toBeLessThan(500);
  });

  test("a CRLF failed wrapper is a failure, not an empty success", () => {
    // The old pattern's `\n*` accepted an LF blank line but not a CRLF one, so on Windows
    // wrappers this branch fell through to the empty-SUCCESS text and erased the failure.
    const out = normalizeCursorToolResultText("Script failed\r\n\r\nOutput:", { toolName: "exec", isError: false });
    expect(out.changed).toBe(true);
    expect(out.text).toContain("exec failed");
    expect(out.text).not.toContain("NOT lost context");
  });

  test("failed-wrapper classification matches the shapes it accepted before", () => {
    const accepted = [
      "Script failed",
      "Script failed\nOutput:",
      "Script failed\nOutput: <empty>",
      "Script failed\nWall time 1.2 seconds",
      "Script failed\nWall time 1.2 seconds\nOutput: <empty>",
      "Script failed\n\n\nOutput:",
      "Script failed\nWall time 1s\n\nOutput:",
    ];
    for (const wrapper of accepted) {
      const out = normalizeCursorToolResultText(wrapper, { toolName: "exec", isError: false });
      expect(out.text).toContain("exec failed");
    }

    const rejected = [
      "Script failed\nOutput:\nreal output",
      "Script failed\nWall time 1s\nsomething real",
      "Script failed\nOutput: <empty> trailing",
    ];
    for (const wrapper of rejected) {
      const out = normalizeCursorToolResultText(wrapper, { toolName: "exec", isError: false });
      expect(out.changed).toBe(false);
      expect(out.text).toBe(wrapper);
    }
  });

  test("computer-use empties keep the original error semantics", () => {
    const out = normalizeCursorToolResultText("", { toolName: "screenshot" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("get_app_state");
  });

  test("unrelated tools with empty output stay untouched", () => {
    const out = normalizeCursorToolResultText("", { toolName: "get_weather" });
    expect(out.changed).toBe(false);
  });
});
