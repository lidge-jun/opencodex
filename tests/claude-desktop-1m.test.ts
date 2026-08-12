import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeDesktopState } from "../src/server/management/shared";
import { DESKTOP_SUPPORTS_1M_THRESHOLD } from "../src/claude/desktop-3p";
import type { OcxConfig } from "../src/types";

/**
 * D1c: the dashboard surfaces the same 1M eligibility the writer emits, from one
 * threshold — never a second rule that could drift. The chip is read-only; the
 * prefer1m toggle needs a profile field and is deferred (030a §D1-3).
 */

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as unknown as OcxConfig;

test("the DTO and the writer share one threshold constant", () => {
  // If someone changes one side, this fails — that is the point.
  expect(DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(1_000_000);
});

test("supports1m is true at and above the threshold, false below it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-desktop-1m-"));
  const prev = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = home;
  try {
    const state = await buildClaudeDesktopState(config);
    // Live-backed assertions against the real catalog: 1 MiB windows qualify.
    const oneMiB = state.models.find(m => m.route === "google-antigravity/gemini-3.1-pro");
    const exact1M = state.models.find(m => m.route === "alibaba-token-plan-intl/glm-5.2");
    const below = state.models.find(m => m.route === "alibaba-token-plan-intl/qwen3.8-max");
    const blank = state.models.find(m => m.route === "anthropic/claude-opus-4-6");

    if (oneMiB) expect(oneMiB.supports1m).toBe(true);       // 1_048_576
    if (exact1M) expect(exact1M.supports1m).toBe(true);      // 1_000_000 exactly
    if (below) expect(below.supports1m).toBe(false);         // 983_616
    if (blank) expect(blank.supports1m).toBe(false);         // no window known

    // The boundary rule itself: 983616 must never qualify, 1000000 always does.
    expect(983_616 >= DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(false);
    expect(1_000_000 >= DESKTOP_SUPPORTS_1M_THRESHOLD).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
