import { expect, test } from "bun:test";
import { logMatchesSurface } from "../src/pages/logs-surface-filter";

test("Logs surface filter matches Usage buckets including Grok", () => {
  expect(logMatchesSurface({}, "all")).toBe(true);
  expect(logMatchesSurface({ surface: "grok" }, "all")).toBe(true);

  expect(logMatchesSurface({ surface: "claude" }, "claude")).toBe(true);
  expect(logMatchesSurface({ surface: "claude-desktop" }, "claude")).toBe(true);
  expect(logMatchesSurface({ surface: "grok" }, "claude")).toBe(false);
  expect(logMatchesSurface({}, "claude")).toBe(false);

  expect(logMatchesSurface({ surface: "grok" }, "grok")).toBe(true);
  expect(logMatchesSurface({ surface: "claude" }, "grok")).toBe(false);
  expect(logMatchesSurface({}, "grok")).toBe(false);

  expect(logMatchesSurface({}, "codex")).toBe(true);
  expect(logMatchesSurface({ surface: "claude" }, "codex")).toBe(false);
  expect(logMatchesSurface({ surface: "claude-desktop" }, "codex")).toBe(false);
  expect(logMatchesSurface({ surface: "grok" }, "codex")).toBe(false);
});
