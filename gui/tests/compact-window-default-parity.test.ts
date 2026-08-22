import { expect, test } from "bun:test";
import { AUTO_COMPACT_WINDOW_DEFAULT as RUNTIME_DEFAULT } from "../../src/claude/context-windows";
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
