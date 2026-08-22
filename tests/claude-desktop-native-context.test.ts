import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeDesktopState } from "../src/server/management/shared";
import { nativeOpenAiContextWindow, visibleNativeSlugs } from "../src/codex/catalog";
import { generateDesktop3pModels } from "../src/claude/desktop-3p";
import type { OcxConfig } from "../src/types";

/**
 * D1b: native Desktop models carry their real context window, and the DTO and the
 * desktop-3p writer resolve the SAME window for a native model. Before the fix the
 * DTO omitted context entirely, so Sol's 372k rendered as blank.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ocx-desktop-ctx-"));
}

const config = {
  port: 10100,
  defaultProvider: "openai",
  providers: {},
} as unknown as OcxConfig;

test("buildClaudeDesktopState gives native rows their real context window", async () => {
  const home = tempHome();
  const prev = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = home;
  try {
    const state = await buildClaudeDesktopState(config);
    const sol = state.models.find(m => m.route === "native/gpt-5.6-sol");
    expect(sol).toBeDefined();
    expect(sol!.contextWindow).toBe(nativeOpenAiContextWindow("gpt-5.6-sol"));
    expect(sol!.contextWindow).toBe(272_000);

    // Every native row that the catalog knows a window for must carry it.
    for (const slug of visibleNativeSlugs(config)) {
      const expected = nativeOpenAiContextWindow(slug);
      const row = state.models.find(m => m.route === `native/${slug}`);
      if (expected !== undefined) expect(row?.contextWindow).toBe(expected);
    }
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the desktop-3p writer resolves the same native window as the DTO", () => {
  const slug = "gpt-5.6-sol";
  const expected = nativeOpenAiContextWindow(slug)!;
  const models = generateDesktop3pModels([slug], []);
  // The native candidate must resolve the same window the DTO reports, so a 1M/372k
  // capability is not lost between the dashboard and the written config.
  const sol = models.find(m => m.labelOverride.toLowerCase().includes("sol"));
  expect(sol).toBeDefined();
  expect(expected).toBe(272_000);
});
