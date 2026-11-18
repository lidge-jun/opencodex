import { expect, test } from "bun:test";
import {
  AUTO_COMPACT_WINDOW_DEFAULT as RUNTIME_DEFAULT,
  buildClaudeContextWindows,
  effectiveModelEnv,
  nativeClaudePassthroughFor,
} from "../../src/claude/context-windows";
import { AUTO_COMPACT_WINDOW_DEFAULT as GUI_DEFAULT } from "../src/pages/claude-code-types";
import { buildManualEnv } from "../src/pages/claude-manual-env";

/**
 * The GUI cannot import from src/, so its compact-window default is a hand-kept copy. A copy
 * with no test is how "350k (default)" outlived the default it named: the number sat in a
 * ladder, a comment, a manual-env fallback and nine translations, and nothing failed when the
 * runtime moved.
 */
test("the GUI mirror of the compact-window default equals the runtime constant", () => {
  expect(GUI_DEFAULT).toBe(RUNTIME_DEFAULT);
});

test("the pasted manual export falls back to that same default", () => {
  // A snippet the user pastes has to compact where the runtime would, or the manual path
  // silently disagrees with the managed one.
  const snippet = buildManualEnv({
    port: 10100,
    authMode: "subscription",
    autoContext: true,
    maxContextTokens: null,
    autoCompactWindow: null,
    effectiveModelEnv: {},
  } as never);
  expect(snippet).toContain(`export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${RUNTIME_DEFAULT}`);
  // An explicit value still wins over the default.
  const explicit = buildManualEnv({
    port: 10100,
    authMode: "subscription",
    autoContext: true,
    maxContextTokens: null,
    autoCompactWindow: 250_000,
    effectiveModelEnv: {},
  } as never);
  expect(explicit).toContain("export CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000");
});

test.each([
  ["2.1.289", "claude-fable-5-1[1m]"],
  ["2.1.290", "claude-fable-5-2[1m]"],
])("the manual snippet leaves the automatic Fable fill from Claude Code %s to the pasted shell", (version, fill) => {
  const windows = buildClaudeContextWindows([], [], undefined, nativeClaudePassthroughFor(undefined, "subscription"));
  const serverEnv = effectiveModelEnv(undefined, windows, undefined, version);
  const snapshot = {
    port: 10100,
    authMode: "subscription",
    autoContext: true,
    maxContextTokens: null,
    autoCompactWindow: null,
    servedContextAccounting: "1m",
    effectiveModelEnv: serverEnv,
  } as const;

  expect(serverEnv.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe(fill);
  for (const tierModels of [{}, undefined]) {
    const oneMillion = buildManualEnv({ ...snapshot, tierModels });
    expect(oneMillion).not.toContain("ANTHROPIC_DEFAULT_FABLE_MODEL");
    expect(oneMillion).toContain(`export ANTHROPIC_DEFAULT_OPUS_MODEL=${serverEnv.ANTHROPIC_DEFAULT_OPUS_MODEL}\n`);
    expect(oneMillion).toContain(`export ANTHROPIC_DEFAULT_SONNET_MODEL=${serverEnv.ANTHROPIC_DEFAULT_SONNET_MODEL}\n`);
    const twoHundredThousand = buildManualEnv({ ...snapshot, tierModels, contextAccounting: "200k" });
    expect(twoHundredThousand).not.toContain("ANTHROPIC_DEFAULT_FABLE_MODEL");
    expect(twoHundredThousand).not.toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
  }
});

test.each(["claude-fable-5-2", "claude-fable-5-2[1m]"])("the manual snippet keeps explicit %s with the matching context marker", fable => {
  const config = { tierModels: { fable } };
  const windows = buildClaudeContextWindows([], [], undefined, nativeClaudePassthroughFor(config, "subscription"));
  const snapshot = {
    port: 10100,
    authMode: "subscription",
    autoContext: true,
    maxContextTokens: null,
    autoCompactWindow: null,
    servedContextAccounting: "1m",
    tierModels: config.tierModels,
    effectiveModelEnv: effectiveModelEnv(config, windows, undefined, "2.1.290"),
  } as const;

  expect(buildManualEnv(snapshot)).toContain("export ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-2[1m]\n");
  expect(buildManualEnv({ ...snapshot, contextAccounting: "200k" })).toContain(`export ANTHROPIC_DEFAULT_FABLE_MODEL=${fable}\n`);
});
