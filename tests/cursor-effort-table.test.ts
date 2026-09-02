import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadCursorEffortTable,
  parseCursorEffortTable,
  resetCursorEffortTableCacheForTests,
  type CursorEffortTable,
  type CursorEffortTableDeps,
} from "../src/integrations/cursor-effort-table";
import type { CursorInstall } from "../src/integrations/cursor-detect";
import { predictCursorEffort } from "../src/server/models-capabilities";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/cursor-agent-exec-effort-table.min.js"), "utf8");
const INSTALL: CursorInstall = { build: "private-inference", path: "/Applications/Cursor Private Inference.app", version: "3.18.25" };

function parsedFixtureTable(): CursorEffortTable {
  const parsed = parseCursorEffortTable(FIXTURE);
  if (!parsed) throw new Error("Cursor effort fixture did not parse");
  return { ...parsed, version: INSTALL.version, bundlePath: "/fixture/main.js" };
}

describe("Cursor installed-bundle effort table", () => {
  beforeEach(() => resetCursorEffortTableCacheForTests());

  test("parses the 3.18.25 literal window from unrelated minified source", () => {
    const table = parsedFixtureTable();
    expect(table.families).toHaveLength(16);
    expect(table.families.find(family => family.id === "anthropic-opus-5")).toMatchObject({
      ladder: ["low", "medium", "high", "xhigh", "max"],
      param: "output_config.effort",
      defaultValue: "high",
      outputCap: 128000,
    });
    expect(table.families.find(family => family.id === "gemini")?.requiresReasoningCapability).toBe(true);
    expect(table.families.find(family => family.id === "anthropic-haiku-4-5")).toMatchObject({
      ladder: [],
      outputCap: 32768,
    });
    expect(table.bareGpt5?.defaultValue).toBe("medium");
  });

  test("predicts by normalized picker id and preserves unmatched bundle rows as null", () => {
    const table = parsedFixtureTable();
    expect(predictCursorEffort("anthropic/claude-opus-5", table)).toMatchObject({
      ladder: ["low", "medium", "high", "xhigh", "max"],
      source: "bundle",
      family: "anthropic-opus-5",
    });
    expect(predictCursorEffort("anthropic/claude-fable-5-1", table)).toEqual({ ladder: null, source: "bundle", family: null });
    expect(predictCursorEffort("cursor/kimi-k3", table)).toEqual({ ladder: null, source: "bundle", family: null });
    expect(predictCursorEffort("gpt-5.4", table)).toEqual({
      ladder: ["low", "medium", "high", "xhigh"],
      source: "bundle",
      family: "gpt-5",
    });
    expect(predictCursorEffort("xai/grok-4.6@main", table)).toMatchObject({
      ladder: ["minimal", "low", "medium", "high", "xhigh"],
      source: "bundle",
      family: "grok-4.6",
    });
  });

  test("activates the static fallback for missing installs, missing literals, and malformed regexes", () => {
    const missingStat: CursorEffortTableDeps = {
      platform: "darwin",
      stat: () => null,
      readText: () => { throw new Error("readText must not run without a stat"); },
    };
    expect(loadCursorEffortTable(INSTALL, missingStat)).toBeNull();

    const loadSource = (source: string, mtimeMs: number) => loadCursorEffortTable(INSTALL, {
      platform: "darwin",
      stat: () => ({ mtimeMs, size: source.length }),
      readText: () => source,
    });
    expect(loadSource("function unrelated(){}", 1)).toBeNull();
    expect(loadSource(FIXTURE.replace("/^claude-opus-5$/u", "/[/u"), 2)).toBeNull();
    // A build that adds a property to ONE family row must not yield a partial table.
    expect(loadSource(FIXTURE.replace('effort:k,outputCap:128e3}', 'effort:k,outputCap:128e3,newFlag:!0}'), 3)).toBeNull();
    // A malformed bare gpt-5 pattern rejects the whole parse instead of throwing.
    expect(loadSource(FIXTURE.replace("/^gpt-5(?:\\.\\d+)?$/u.test(t)", "/^gpt-5(/u.test(t)"), 4)).toBeNull();
    expect(predictCursorEffort("anthropic/claude-opus-5", null)).toEqual({
      ladder: ["low", "medium", "high", "xhigh", "max"],
      source: "static",
      family: null,
    });
  });

  test("gemini withholds its ladder when the row will not advertise supports_reasoning", () => {
    const table = parsedFixtureTable();
    expect(predictCursorEffort("cursor/gemini-3.7-flash", table, true).ladder).toEqual(["minimal", "low", "medium", "high"]);
    expect(predictCursorEffort("cursor/gemini-3.7-flash", table, false)).toEqual({ ladder: null, source: "bundle", family: "gemini" });
    expect(predictCursorEffort("cursor/gemini-3.7-flash", null, false).ladder).toBeNull();
    // Other families ignore the flag: Cursor gates only gemini on it.
    expect(predictCursorEffort("anthropic/claude-opus-5", table, false).ladder).toHaveLength(5);
  });

  test("caches by bundle path, mtime, and size and re-reads after mtime changes", () => {
    let mtimeMs = 1;
    let reads = 0;
    const deps: CursorEffortTableDeps = {
      platform: "darwin",
      stat: () => ({ mtimeMs, size: FIXTURE.length }),
      readText: () => {
        reads += 1;
        return FIXTURE;
      },
    };
    expect(loadCursorEffortTable(INSTALL, deps)?.families).toHaveLength(16);
    expect(loadCursorEffortTable(INSTALL, deps)?.families).toHaveLength(16);
    expect(reads).toBe(1);
    mtimeMs = 2;
    expect(loadCursorEffortTable(INSTALL, deps)?.families).toHaveLength(16);
    expect(reads).toBe(2);
  });
});
