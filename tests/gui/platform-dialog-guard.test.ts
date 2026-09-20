import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { findPlatformDialogCalls } from "../helpers/platform-dialog-scan";
import { repoPath, repoRoot } from "../helpers/repo-root";

/**
 * The dashboard must not call `confirm`, `alert` or `prompt`.
 *
 * Inside the desktop app those three draw nothing: wry implements no `WKUIDelegate`
 * JavaScript panel methods, so WKWebView suppresses the panel entirely. Thirteen consent
 * gates and seven result reports were inoperative there — including the sidebar stop and
 * refresh orbs — while the same dashboard worked in a browser.
 * See devlog/_plan/260921_app_runtime_ownership/050_webview_dialogs.md.
 *
 * CI could not have caught the original defect because the GUI tests encoded browser
 * dialogs as available: they stubbed `confirm()` to true and `alert()` to a no-op. A
 * regression test for this has to assert the ABSENCE of the platform dialogs, which is what
 * this file does for the source and what gui/tests/action-dialogs.test.ts does at runtime.
 */
function dashboardSources(): string[] {
  return execFileSync("git", ["ls-files", "gui/src"], { cwd: repoRoot(), encoding: "utf8" })
    .split("\n")
    .filter(file => file.endsWith(".ts") || file.endsWith(".tsx"));
}

describe("dashboard platform-dialog guard", () => {
  test("no dashboard source calls confirm, alert or prompt", () => {
    const files = dashboardSources();
    // A scan that found nothing because it read nothing would pass silently.
    expect(files.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of files) {
      for (const call of findPlatformDialogCalls(readFileSync(repoPath(file), "utf8"))) {
        offenders.push(`${file}:${call.line} ${call.form}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard reports every global call form", () => {
    const reported = (source: string) => findPlatformDialogCalls(source).map(call => call.form);

    expect(reported("if (!confirm(message)) return;")).toEqual(["confirm("]);
    expect(reported("alert(outcome.message);")).toEqual(["alert("]);
    expect(reported("const entered = window.prompt(label, current);")).toEqual(["window.prompt("]);
    expect(reported("window.confirm(question)")).toEqual(["window.confirm("]);
    expect(reported("globalThis.alert(text)")).toEqual(["globalThis.alert("]);
    expect(reported("self.confirm(question)")).toEqual(["self.confirm("]);
    // Whitespace and optional chaining are the same call.
    expect(reported("window ?. confirm ( question )")).toEqual(["window?.confirm("]);
    // Call position after a keyword is still a call.
    expect(reported("return confirm(question);")).toEqual(["confirm("]);
    expect(reported("const answer = await confirm(question);")).toEqual(["confirm("]);
    expect(reported("void alert(message);")).toEqual(["alert("]);
  });

  test("the guard leaves the legitimate shapes alone", () => {
    // A confirm() method on a session object.
    expect(findPlatformDialogCalls("await session.confirm();")).toEqual([]);
    expect(findPlatformDialogCalls("class S {\n  async confirm(): Promise<void> {}\n}")).toEqual([]);
    // The admin-token helper, whose name merely contains one of the words.
    expect(findPlatformDialogCalls("const token = await promptForAdminToken(verify);")).toEqual([]);
    // An executable sample string that contains the word.
    expect(findPlatformDialogCalls("const sample = `const key = prompt(label);`;")).toEqual([]);
    expect(findPlatformDialogCalls('const sample = "confirm(question)";')).toEqual([]);
    expect(findPlatformDialogCalls("// the refresh orb used to call confirm(message)")).toEqual([]);
    expect(findPlatformDialogCalls("/* alert(message) drew nothing */")).toEqual([]);
    // A property named for one of them, and a regular expression that mentions one.
    expect(findPlatformDialogCalls("const request = { confirm: true, prompt: text };")).toEqual([]);
    expect(findPlatformDialogCalls("const pattern = /confirm\\(/;")).toEqual([]);
  });

  test("code inside a template hole is still code", () => {
    // The mask must not swallow an interpolation: that is how a scanner stops reporting.
    expect(findPlatformDialogCalls("const url = `${confirm(question)}`;").map(c => c.form)).toEqual(["confirm("]);
    expect(findPlatformDialogCalls("const url = `/api/${id}`; alert(done);").map(c => c.form)).toEqual(["alert("]);
  });

  test("a regular expression holding a quote does not mask the rest of the file", () => {
    // An unmasked /['"]/ reads as the start of a string literal and hides everything after
    // it, which would turn this guard green by blinding it.
    const source = "const quoted = /['\"]/;\nalert(message);";
    expect(findPlatformDialogCalls(source).map(call => call.form)).toEqual(["alert("]);
  });

  /*
   * Shapes an earlier revision of the scanner missed. Each one is a way of writing or
   * neighbouring a real global call that the lexer or the call pattern failed to see, and a
   * missed call is the failure mode that matters: a false positive is loud, a false
   * negative is a guard that has quietly stopped guarding.
   */
  test("the guard is not blinded by neighbouring syntax", () => {
    const reported = (source: string) => findPlatformDialogCalls(source).map(call => call.form);

    // A JSX closing tag is not a regular expression, and an apostrophe in JSX body text is
    // not a string. Either reading masked the rest of the line.
    expect(reported("const view = <div>don't</div>; alert(message);")).toEqual(["alert("]);
    // A newline says nothing about whether the next slash divides.
    expect(reported("const ratio = numerator\n/ alert(message);")).toEqual(["alert("]);
    // A slash inside a character class does not close the pattern.
    expect(reported("function f() { return /['/]/; } alert(message);")).toEqual(["alert("]);
    // An arrow's => still opens a regular expression, so this one stays masked.
    expect(reported("const f = x => /confirm\\(/.test(x);")).toEqual([]);
  });

  test("the guard reads the less obvious call spellings", () => {
    const reported = (source: string) => findPlatformDialogCalls(source).map(call => call.form);

    expect(reported("confirm?.(question);")).toEqual(["confirm?.("]);
    expect(reported("(confirm)(question);")).toEqual(["(confirm)("]);
    // A line continuation keeps the string open; the call after it is still code.
    expect(reported('const s = "continued\\\r\ntext"; alert(message);')).toEqual(["alert("]);
  });
});
