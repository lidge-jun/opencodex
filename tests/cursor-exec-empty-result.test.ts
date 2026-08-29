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

  test("an indented empty marker after Output: still classifies as a failed wrapper", () => {
    // These three classified under the previous regex. A line-scan rewrite that treated the
    // marker as needing to start its own line rejected them, leaving the wrapper unnormalized
    // and the failure unexplained.
    for (const wrapper of [
      "Script failed\nOutput:\n\n <empty>",
      "Script failed\nOutput:\n  <empty>",
      "Script failed\nOutput:\n <empty>",
    ]) {
      const out = normalizeCursorToolResultText(wrapper, { toolName: "exec", isError: false });
      expect(out.changed).toBe(true);
      expect(out.text).toContain("exec failed");
    }
  });

  test("a duplicate empty marker is left alone rather than erased", () => {
    // The damaging direction: classifying these would replace a real payload with the failed-wrapper
    // guidance. The previous regex rejected them and so must any replacement.
    for (const wrapper of [
      "Script failed\nOutput:\t<empty>\n<empty>",
      "Script failed\nOutput: <empty>\n\n<empty>",
      "Script failed\nOutput: <empty>\n<empty>",
    ]) {
      const out = normalizeCursorToolResultText(wrapper, { toolName: "exec", isError: false });
      expect(out.changed).toBe(false);
      expect(out.text).toBe(wrapper);
    }
  });

  test("CRLF blank separators reach the failure guidance instead of the empty-success text", () => {
    // The one intentional behaviour change. The old regex matched only `\n`, so a Windows-produced
    // failed wrapper fell through to the empty-SUCCESS message — telling the model nothing went
    // wrong when the cell had in fact failed.
    for (const wrapper of [
      "Script failed\r\n\r\n\r\nOutput:",
      "Script failed\r\n\r\n<empty>",
      "Script failed\r\n\r\nOutput:",
      "Script failed\r\nWall time 1s\r\n\r\nOutput:",
    ]) {
      const out = normalizeCursorToolResultText(wrapper, { toolName: "exec", isError: false });
      expect(out.changed).toBe(true);
      expect(out.text).toContain("exec failed");
      expect(out.text).not.toContain("NOT lost context");
    }
  });

  test("a long whitespace run followed by a non-matching character classifies in bounded work", () => {
    // A pathological shape for the classifier this replaced. Measured in CPU time rather than
    // elapsed wall time: `performance.now()` counts OS descheduling, VM pauses and GC, so a loaded
    // CI runner can blow any wall-clock budget while the code under test did nothing wrong.
    // `process.cpuUsage()` counts only work this process actually performed.
    //
    // The bound is deliberately three orders of magnitude above the scan's real cost. It is not a
    // performance target; it is a tripwire wide enough that only a return to super-linear work can
    // cross it, which is the single thing this test exists to catch.
    const malformed = `Script failed${" ".repeat(60_000)}\nY`;

    // Warm up so first-call JIT and allocation land outside the measurement.
    normalizeCursorToolResultText(malformed, { toolName: "exec", isError: false });

    const before = process.cpuUsage();
    const out = normalizeCursorToolResultText(malformed, { toolName: "exec", isError: false });
    const spent = process.cpuUsage(before);
    const cpuMs = (spent.user + spent.system) / 1000;

    expect(out.changed).toBe(false);
    expect(out.text).toBe(malformed);
    expect(cpuMs).toBeLessThan(250);
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
