import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The WidgetKit extension shipped registered and empty.
 *
 * `app/Package.swift` forced the executable's entry to `_NSExtensionMain` and `main.swift` was
 * comments, so nothing ever called `OpenCodexWidgetBundle.main()`. The extension still appeared
 * in `pluginkit` — that comes from the Info.plist alone — and `NSExtensionMain` then looked for
 * an `NSExtensionPrincipalClass` a SwiftUI widget does not declare. The result is a widget that
 * installs, registers, and is never offered in the gallery, with no error anywhere.
 *
 * Nothing in the build catches that: the bundle is well formed, the signature verifies, and the
 * binary links WidgetKit. Only the entry point is wrong, which is why it is asserted here.
 */
const PACKAGE = repoPath("app/Package.swift");
const ENTRY = repoPath("app/Sources/OpenCodexWidget/main.swift");

describe("widget extension entry point", () => {
  test("the linker entry is not redirected away from the Swift main", () => {
    const manifest = readFileSync(PACKAGE, "utf8");
    // Strip comments first, so the explanation of why this override is wrong does not read as
    // the override itself.
    const code = manifest.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("_NSExtensionMain");
    expect(code).not.toContain("-e");
  });

  test("main.swift hands the bundle to WidgetKit", () => {
    const entry = readFileSync(ENTRY, "utf8");
    const code = entry.replace(/\/\/[^\n]*/g, "");
    expect(code).toContain("import WidgetKit");
    expect(code).toMatch(/OpenCodexWidgetBundle\.main\(\)/);
  });

  test("the bundle it calls is the one the views define", () => {
    const views = readFileSync(repoPath("app/Sources/OpenCodexWidget/Views.swift"), "utf8");
    expect(views).toMatch(/struct OpenCodexWidgetBundle: WidgetBundle/);
    // A WidgetBundle with no body offers nothing, which is the same failure by another route.
    expect(views).toMatch(/OpenCodexWidget\(\)/);
  });
});
