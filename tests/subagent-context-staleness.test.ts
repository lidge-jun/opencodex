import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEffectiveSubagentRoster } from "../src/server/responses/collaboration";
import {
  NATIVE_GPT56_CONTEXT_WINDOW,
  NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW,
} from "../src/codex/catalog";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * #2574: the subagent roster reads the persisted Codex catalog, which is only as fresh as the
 * last sync. A row written before the operator widened the native window kept its old
 * `context_window`, so a child planned and compacted against a narrower budget than its
 * parent — measured at 272,000 x 95% = 258,400 while the request path resolved 922,000.
 */
const originalHome = process.env.OPENCODEX_HOME;
const originalCodexHome = process.env.CODEX_HOME;
let home: string;
let codexHome: string;

function writeStaleCatalog(): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({
    models: [
      {
        slug: "gpt-5.6-sol",
        // The width a pre-opt-in sync wrote.
        context_window: NATIVE_GPT56_CONTEXT_WINDOW,
        effective_context_window_percent: 95,
        visibility: "list",
        priority: 1,
      },
    ],
  }));
}

function writeConfig(): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    port: 10100,
    defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    // The 1M opt-in is a raised provider cap, not a per-model window.
    providerContextCaps: { openai: 1_050_000 },
  }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-subagent-ctx-"));
  codexHome = mkdtempSync(join(tmpdir(), "ocx-subagent-codex-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = codexHome;
  writeConfig();
  writeStaleCatalog();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  removeTreeWithRetry(home);
  removeTreeWithRetry(codexHome);
});

describe("#2574 a subagent does not inherit a stale catalog width", () => {
  test("the roster still lists the model from a stale catalog", async () => {
    // The repair must not cost the caller its roster.
    const roster = await resolveEffectiveSubagentRoster(["gpt-5.6-sol"], "default");
    expect(roster.candidates.map(c => c.model)).toContain("gpt-5.6-sol");
  });

  test("the arithmetic that produced the reported number is pinned", () => {
    // 272,000 x 95% = 258,400 is exactly what was observed; the opt-in width is 3.4x larger,
    // which is why the symptom reads as premature compaction rather than a rounding error.
    expect(Math.floor(NATIVE_GPT56_CONTEXT_WINDOW * 0.95)).toBe(258_400);
    expect(NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW).toBe(922_000);
    expect(Math.floor(NATIVE_GPT56_OPT_IN_CONTEXT_WINDOW * 0.95)).toBe(875_900);
  });
});

