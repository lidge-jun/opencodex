import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The main window's host-visibility bridge.
 *
 * Windows WebView2 does not flip `document.visibilityState` when the host window is hidden to the
 * tray (tauri issues #10592 and #6864), so on Windows a hidden dashboard keeps polling while macOS
 * WKWebView (measured) stops. The shell therefore publishes its own answer: the page global
 * `window.__OPENCODEX_HOST_VISIBLE__` plus an `opencodex:host-visibility` CustomEvent, sent when
 * the window is shown or hidden by the shell and re-sent after every page load of the main window.
 *
 * The wiring is what carries that contract, and no CI job can observe it: the shell is built
 * against a placeholder sidecar and there is no session to hide a real window in. It is read out of
 * the Rust source, the way the exit ownership and start-at-login orderings already are.
 */
const SRC = "desktop/src-tauri/src";
const WINDOW = repoPath(`${SRC}/window.rs`);
const LIB = repoPath(`${SRC}/lib.rs`);
const POPUP = repoPath(`${SRC}/popup.rs`);

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
}

/** The body of one function, from its signature to the first line that closes it. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("\n}"));
}

describe("desktop host visibility bridge", () => {
  test("only the main window publishes its visibility", () => {
    const report = body(code(WINDOW), "pub fn report_visibility(");
    // exit.rs hides every window through window::hide, and the tray popup has its own bridge, so
    // an unguarded report would answer for the dashboard from a popup.
    expect(report).toContain('if window.label() != "main"');
    expect(report).toContain("return;");
    expect(report).toContain("window.__OPENCODEX_HOST_VISIBLE__ = {visible}");
    expect(report).toContain("new CustomEvent('opencodex:host-visibility'");
    expect(report).toContain("window.eval(");
  });

  test("show and hide report the state they just applied", () => {
    const window = code(WINDOW);
    const show = body(window, "pub fn show(");
    expect(show).toContain("report_visibility(window, true)");
    expect(show.indexOf("report_visibility(window, true)")).toBeGreaterThan(
      show.indexOf("window.show()"),
    );
    const hide = body(window, "pub fn hide(");
    expect(hide).toContain("report_visibility(window, false)");
    expect(hide.indexOf("report_visibility(window, false)")).toBeGreaterThan(
      hide.indexOf("window.hide()"),
    );
  });

  test("the main window re-reports its visibility after every page load", () => {
    const lib = code(LIB);
    const builder = lib.slice(lib.indexOf('WebviewWindowBuilder::new(app, "main"'));
    expect(builder.length).toBeGreaterThan(0);
    const built = builder.slice(0, builder.indexOf(".build()?"));
    // A hidden window still navigates: the bootstrap page hands off to the dashboard URL, and a
    // reload would otherwise leave the page's answer stale until the next show or hide.
    expect(built).toContain(".on_page_load(");
    expect(built).toContain("tauri::webview::PageLoadEvent::Finished");
    expect(built).toContain("window::report_visibility(");
    expect(built).toContain("window.is_visible().unwrap_or(false)");
  });

  test("the tray popup's bridge is not the main window's", () => {
    const popup = code(POPUP);
    expect(popup).toContain("__OPENCODEX_TRAY_VISIBLE__");
    expect(popup).toContain("opencodex:tray-visibility");
    // Its window is not the dashboard, so its visibility must not answer for it.
    expect(popup).not.toContain("__OPENCODEX_HOST_VISIBLE__");
    expect(popup).not.toContain("opencodex:host-visibility");
  });
});
