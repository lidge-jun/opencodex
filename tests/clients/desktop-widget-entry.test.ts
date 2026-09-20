import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The WidgetKit extension needs two things that look unrelated, and either one alone produces a
 * widget that is never offered in the gallery with nothing in the build to say so.
 *
 * Without `@main` on the WidgetBundle, nothing references it, the linker drops it, and the
 * extension still registers with `pluginkit` because the Info.plist alone is enough. The gallery
 * then has no configuration to offer. That is what shipped.
 *
 * Without the `_NSExtensionMain` linker entry, the Swift main runs instead of the extension host's
 * bootstrap and ExtensionFoundation traps in `_EXRunningExtension._shared` — EXC_BREAKPOINT on
 * every launch, one crash report per attempt, and `chronod` logging
 * "query failed - will try lazy reload later".
 *
 * Both were measured on a real install. Neither is visible to a build that only checks the bundle
 * is well formed and the signature verifies, which is why they are asserted from the source.
 */
const PACKAGE = repoPath("app/Package.swift");
const VIEWS = repoPath("app/Sources/OpenCodexWidget/Views.swift");

function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

describe("widget extension entry point", () => {
  test("the linker entry is NSExtensionMain, as it is for an Xcode app-extension target", () => {
    const code = stripComments(readFileSync(PACKAGE, "utf8"));
    expect(code).toContain("_NSExtensionMain");
  });

  test("the target is compiled in extension-only mode", () => {
    // Xcode's app-extension target sets APPLICATION_EXTENSION_API_ONLY; SwiftPM has no such
    // target, so the compiler's spelling is passed by hand. It belongs beside the linker entry
    // because the two are one contract: the projects that have a SwiftPM widget extension
    // working supply both, and dropping either brings back a failure that the build, the
    // signature and the registration all continue to look fine through.
    const code = stripComments(readFileSync(PACKAGE, "utf8"));
    expect(code).toContain("-application-extension");
  });

  test("the widget bundle is the Swift entry, so the linker keeps it", () => {
    const views = readFileSync(VIEWS, "utf8");
    expect(views).toMatch(/@main\s*\n\s*struct OpenCodexWidgetBundle: WidgetBundle/);
  });

  test("there is no main.swift competing with @main", () => {
    // SwiftPM refuses @main in a target that also has a main.swift, and the refusal is a build
    // error rather than a silent fallback - but the file existing at all means someone moved the
    // entry back out of the bundle.
    expect(existsSync(repoPath("app/Sources/OpenCodexWidget/main.swift"))).toBe(false);
  });

  test("the bundle actually carries a widget", () => {
    const views = readFileSync(VIEWS, "utf8");
    // A WidgetBundle with an empty body offers nothing, which is the same failure by another route.
    expect(views).toMatch(/OpenCodexWidget\(\)/);
    expect(views).toMatch(/configurationDisplayName/);
  });
});
