import { beforeEach, describe, expect, test } from "bun:test";
import {
  fetchCodeBuddyModels,
  parseCodeBuddyHelpRoster,
  type CodeBuddyExecFn,
} from "../../src/adapters/codebuddy/live-models";
import { CODEBUDDY_CN_PROFILE, clearCodeBuddyBinaryCache } from "../../src/adapters/codebuddy/profiles";

// The binary-discovery cache is module-level; reset it so one test's injected binary
// cannot mask another test's missing-binary case.
beforeEach(() => clearCodeBuddyBinaryCache());

const ROSTER_LINE = "  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy4-preview-f, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3-pay, minimax-m2.7, kimi-k3-2, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro)";

describe("CodeBuddy help-roster parser", () => {
  test("parses the account roster in order", () => {
    const result = parseCodeBuddyHelpRoster(ROSTER_LINE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toHaveLength(16);
      expect(result.models[0]).toBe("hy4-preview-f");
      expect(result.models).toContain("kimi-k3-2");
      expect(result.models).toContain("deepseek-v4.1-flash");
    }
  });

  test("filters custom selectors, blanks, and duplicates", () => {
    const result = parseCodeBuddyHelpRoster("--model <model>  Model for the current session. Please provide the model ID. Currently supported: (kimi-k3-2, custom:mine, kimi-k3-2, )");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toEqual(["kimi-k3-2"]);
  });

  test("a missing roster line fails closed", () => {
    expect(parseCodeBuddyHelpRoster("Usage: codebuddy|cbc [options] [command] [prompt]"))
      .toMatchObject({ ok: false, error: "invalid_output" });
  });

  test("an empty roster fails closed", () => {
    expect(parseCodeBuddyHelpRoster("--model <model>  Model for the current session. Please provide the model ID. Currently supported: ()"))
      .toMatchObject({ ok: false, error: "empty" });
  });
});

describe("CodeBuddy live model fetch", () => {
  test("spawns the CLI with the account env and returns the roster", async () => {
    let seenCommand = "";
    let seenArgs: readonly string[] = [];
    let seenEnv: Record<string, string> = {};
    const exec: CodeBuddyExecFn = async (command, args, options) => {
      seenCommand = command;
      seenArgs = args;
      seenEnv = options.env;
      return { stdout: ROSTER_LINE, stderr: "" };
    };
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { which: () => "/usr/bin/codebuddy", exec });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toContain("kimi-k3-2");
    expect(seenCommand).toBe("/usr/bin/codebuddy");
    expect(seenArgs).toEqual(["--help"]);
    expect(seenEnv.CODEBUDDY_API_KEY).toBe("cb-cn-key");
    expect(seenEnv.CODEBUDDY_INTERNET_ENVIRONMENT).toBe("internal");
  });

  test("a missing CLI is a clear error, never a crash", async () => {
    const result = await fetchCodeBuddyModels(CODEBUDDY_CN_PROFILE, "cb-cn-key", { which: () => undefined });
    expect(result).toMatchObject({ ok: false, error: "cli_not_found" });
  });
});
