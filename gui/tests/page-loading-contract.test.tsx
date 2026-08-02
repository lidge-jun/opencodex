import { expect, test } from "bun:test";

/**
 * WP3 (devlog/_plan/260730_gui_hydration_loading_unify/020_page_migration.md).
 *
 * Every migrated surface answers the same three questions the same way: replace the content
 * while cold, report progress next to content that is already on screen, and keep a failure
 * distinguishable from an empty result. These are source-level pins — the behavioural proof for
 * the contract itself lives in data-surface.test.tsx.
 *
 * Each surface is added here by its own migration commit, so the list doubles as the progress
 * ledger for WP3.
 */

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

/**
 * Pages name their local state binding differently (`state`, `loadState`, `logsState`), so match
 * the contract's field access rather than one variable name. Pinning a name would make this test
 * a rename detector instead of a contract check.
 */
const usesField = (source: string, field: string): boolean =>
  new RegExp(`\\.${field}\\b`).test(source);

/** Surfaces migrated so far, in migration order. */
const MIGRATED = [
  { name: "Grok", file: "../src/pages/Grok.tsx" },
  { name: "Subagents", file: "../src/pages/Subagents.tsx" },
  { name: "Combos", file: "../src/pages/Combos.tsx" },
  { name: "Usage", file: "../src/pages/Usage.tsx" },
  { name: "Startup", file: "../src/pages/Startup.tsx" },
  { name: "Logs", file: "../src/pages/Logs.tsx" },
  { name: "Debug", file: "../src/pages/Debug.tsx" },
  { name: "ClaudeCode", file: "../src/pages/ClaudeCode.tsx" },
  { name: "ClaudeDesktop", file: "../src/pages/ClaudeDesktop.tsx" },
  { name: "Storage", file: "../src/pages/Storage.tsx" },
  { name: "ApiKeys", file: "../src/pages/ApiKeys.tsx" },
  { name: "Models", file: "../src/pages/Models.tsx" },
] as const;

test("every migrated surface subscribes through the shared resource layer", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("useDataSurface");
  }
});

test("no migrated surface defers its mount fetch behind a zero-delay timer", async () => {
  // The retired pattern cancelled the timer in cleanup, so a route change during the first tick
  // dropped the request with no retry and the tab simply stayed empty.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).not.toContain("setTimeout(() => { void load(); }, 0)");
  }
});

test("every migrated surface renders the shared cold skeleton", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    expect(source, surface.name).toContain("DataSurfaceSkeleton");
    expect(usesField(source, "showSkeleton"), surface.name).toBe(true);
  }
});

test("every migrated surface reports a revalidation over existing content", async () => {
  // These surfaces keep cached panels visible without a status line — a spinner would flash
  // over known state on revisit (Logs also polls every 2s).
  const silentRevalidation = new Set([
    "Debug", "Startup", "Logs", "Subagents", "Usage", "Models", "ClaudeCode", "ClaudeDesktop", "ApiKeys", "Grok",
  ]);
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    if (silentRevalidation.has(surface.name)) {
      expect(usesField(source, "refreshing") || usesField(source, "loading"), surface.name).toBe(true);
      continue;
    }
    expect(source, surface.name).toContain("DataSurfaceStatus");
    expect(
      usesField(source, "refreshing") || usesField(source, "loading"),
      surface.name,
    ).toBe(true);
  }
});

test("a failure after a success stays visible instead of reading as settled", async () => {
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    // `showError` covers a stale failure; `failed-cold` covers the never-succeeded case. A surface
    // that handles neither would silently render as settled after a failed read.
    expect(
      usesField(source, "showError") || source.includes("failed-cold"),
      surface.name,
    ).toBe(true);
  }
});

test("the status line yields its live region to an error notice", async () => {
  const noStatusLine = new Set([
    "Debug", "Startup", "Logs", "Subagents", "Usage", "Models", "ClaudeCode", "ClaudeDesktop", "ApiKeys", "Grok",
  ]);
  // One announcement per transition: two live regions make a screen reader repeat itself.
  for (const surface of MIGRATED) {
    const source = await read(surface.file);
    if (noStatusLine.has(surface.name)) continue;
    expect(
      /live=\{!\w+\.showError\}/.test(source) || source.includes("live={false}"),
      surface.name,
    ).toBe(true);
  }
});
