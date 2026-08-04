import { describe, expect, test } from "bun:test";
import { agentDrivenMarkers, isAgentDriven } from "../src/cli/agent-driven";

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

  test("covers the wider agent and hosted-runner surface", () => {
    // Each of these ships a harness that answers prompts from model output or a
    // script, so a consent question would never reach the account owner.
    for (const name of [
      "CLAUDE_CODE_SSE_PORT",
      "CODEX_SANDBOX",
      "CURSOR_AGENT",
      "OPENCODE_BIN_PATH",
      "GEMINI_CLI",
      "GITLAB_CI",
      "BUILDKITE",
      "JENKINS_URL",
      "TEAMCITY_VERSION",
      "CODESPACES",
    ]) {
      expect(isAgentDriven({ [name]: "1" })).toBe(true);
    }
  });

  test("CODEX_HOME alone is a user's own export, not an agent", () => {
    // Users set it in their shell profile; matching it would silence the prompt
    // for a person sitting at the keyboard.
    expect(isAgentDriven({ CODEX_HOME: "/tmp/example-home/.codex" })).toBe(false);
  });
});

describe("agentDrivenMarkers", () => {
  test("names the detected vars so a refusal can explain itself", () => {
    expect(agentDrivenMarkers({ CLAUDECODE: "1", CI: "true" })).toEqual(["CLAUDECODE", "CI"]);
  });

  test("is empty for a hand-typed run", () => {
    expect(agentDrivenMarkers({ TERM: "xterm-256color" })).toEqual([]);
  });
});
