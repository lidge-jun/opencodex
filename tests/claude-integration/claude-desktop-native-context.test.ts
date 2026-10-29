import { expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeDesktopState } from "../../src/server/management/shared";
import { nativeOpenAiContextWindow, visibleNativeSlugs } from "../../src/codex/catalog";
import { generateDesktop3pModels } from "../../src/claude/desktop-3p";
import { emptyDesktopProfile } from "../../src/claude/desktop-profile";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
  // Sol/Terra/Luna are account-gated; this test is about window metadata, so confirm them.
  seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  const home = tempHome();
  const prev = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = home;
  try {
    const state = await buildClaudeDesktopState(config);
    const sol = state.models.find(m => m.route === "native/gpt-5.6-sol");
    expect(sol).toBeDefined();
    expect(sol!.contextWindow).toBe(nativeOpenAiContextWindow("gpt-5.6-sol"));
    expect(sol!.contextWindow).toBe(272_000);
    expect(state.models.find(m => m.route === "native/gpt-6.1-sol")).toMatchObject({ contextWindow: 500_000 });
    expect(state.models.find(m => m.route === "native/gpt-6.1-terra")).toMatchObject({ contextWindow: 500_000 });

    // Every native row that the catalog knows a window for must carry it.
    for (const slug of visibleNativeSlugs(config)) {
      const expected = nativeOpenAiContextWindow(slug);
      const row = state.models.find(m => m.route === `native/${slug}`);
      if (expected !== undefined) expect(row?.contextWindow).toBe(expected);
    }
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = prev;
    removeTreeWithRetry(home);
    resetCodexModelEntitlementCacheForTests();
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


test.each([
  ["legacy", "gpt-6.1-sol", "GPT 6.1 Sol (native)"],
  ["profile", "gpt-6.1-sol", "GPT 6.1 Sol (native)"],
  ["legacy", "gpt-6.1-terra", "GPT 6.1 Terra (native)"],
  ["profile", "gpt-6.1-terra", "GPT 6.1 Terra (native)"],
] as const)(
  "%s %s config enables supports1m only with long-window opt-in", (mode, slug, label) => {
    const profile = mode === "profile" ? emptyDesktopProfile() : undefined;
    expect(nativeOpenAiContextWindow(slug)).toBe(500_000);
    const defaultSol = generateDesktop3pModels([slug], [], profile)[0];
    expect(defaultSol?.labelOverride).toBe(label);
    expect(defaultSol?.supports1m).toBeUndefined();
    expect(defaultSol?.prefer1m).toBeUndefined();

    const optedInSol = generateDesktop3pModels([slug], [], profile, { modelWindows: { [slug]: 872_000 } })[0];
    expect(optedInSol).toMatchObject({ labelOverride: label, supports1m: true, prefer1m: true });
  },
);
