import { describe, expect, test } from "bun:test";
import { isAgentDriven } from "../src/cli/agent-driven";

describe("isAgentDriven", () => {
  test("a plain user shell is not agent-driven", () => {
    expect(isAgentDriven({ TERM: "xterm-256color", SHELL: "/bin/zsh" })).toBe(false);
  });

  test("recognizes the agent harnesses that run ocx on a user's behalf", () => {
    expect(isAgentDriven({ CLAUDECODE: "1" })).toBe(true);
    expect(isAgentDriven({ CODEX_THREAD_ID: "019fa50b" })).toBe(true);
    expect(isAgentDriven({ CURSOR_TRACE_ID: "abc" })).toBe(true);
    expect(isAgentDriven({ GITHUB_ACTIONS: "true" })).toBe(true);
  });

  test("an empty or whitespace value does not count as set", () => {
    expect(isAgentDriven({ CLAUDECODE: "" })).toBe(false);
    expect(isAgentDriven({ CODEX_THREAD_ID: "   " })).toBe(false);
  });
});
