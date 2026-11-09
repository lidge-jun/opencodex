import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { logMatchesSurface } from "../src/pages/logs-surface-filter";
import { logsSurfaceKeyDown } from "../src/pages/logs-surface-keydown";

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

test("Classic Logs surface radios support wrapping arrows and Home/End with roving focus", () => {
  const previousDocument = globalThis.document;
  const win = new Window();
  Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
  try {
    for (const surface of ["all", "claude", "codex", "grok"]) {
      const button = win.document.createElement("button");
      button.id = `logs-surface-${surface}`;
      win.document.body.append(button);
    }
    const selected: string[] = [];
    const key = (value: string) => ({ key: value, preventDefault() {}, } as never);
    logsSurfaceKeyDown(key("ArrowRight"), "grok", surface => selected.push(surface));
    expect(selected).toEqual(["all"]);
    expect(win.document.activeElement?.id).toBe("logs-surface-all");
    logsSurfaceKeyDown(key("Home"), "codex", surface => selected.push(surface));
    expect(selected).toEqual(["all", "all"]);
    expect(win.document.activeElement?.id).toBe("logs-surface-all");
    logsSurfaceKeyDown(key("Enter"), "all", surface => selected.push(surface));
    expect(selected).toHaveLength(2);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    win.close();
  }
});
