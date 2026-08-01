import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsTrayHostEnvironment } from "../src/tray/windows";

test("Windows tray forwards the recorded Bun source and leaves legacy entries unknown", () => {
  expect(windowsTrayHostEnvironment(
    { bunRuntimeSource: "override" },
    { OCX_BUN_RUNTIME_SOURCE: "bundled", KEEP: "yes" },
  )).toEqual({ OCX_BUN_RUNTIME_SOURCE: "override", KEEP: "yes" });

  expect(windowsTrayHostEnvironment(
    {},
    { OCX_BUN_RUNTIME_SOURCE: "bundled", KEEP: "yes" },
  )).toEqual({ KEEP: "yes" });
});

test("Windows tray resolves its durable Bun path and source as one entry", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows.ts"), "utf8");
  expect(source).toContain("const bunRuntime = durableBunRuntime();");
  expect(source).toContain("bun: bunRuntime.path");
  expect(source).toContain("bunRuntimeSource: bunRuntime.source");
});
