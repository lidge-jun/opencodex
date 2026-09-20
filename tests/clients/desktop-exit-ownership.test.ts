import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * INV-DESKTOP-01 — only the tray's Quit ends the app, and nothing ends the runtime by force.
 *
 * Three gestures used to mean the same thing. Closing the window hid it, but Cmd+Q reached
 * `RunEvent::Exit` with no `ExitRequested` handler in between, and that called
 * `CommandChild::kill()` — a SIGKILL on Unix — on the runtime this app had started. The CLI's own
 * stop restores client configuration, lets in-flight requests finish and clears state files; none
 * of that survived a keystroke the user reads as "hide". The updater took the same path.
 *
 * macOS needs one thing more than the event handler, and it is the part that is easiest to get
 * wrong while believing it works: Tauri's default menu carries a predefined Quit wired straight to
 * Cocoa's `terminate:`, and the pinned tao raises no cancellable event for it, so `prevent_exit`
 * never sees it. The replacement item is therefore part of this contract, not a detail.
 *
 * The wiring is the contract and it is not visible from behaviour alone — CI builds the shell
 * against a zero-byte sidecar and has no session to press Cmd+Q in — so it is read out of the
 * source, the way the Start at Login ordering already is.
 */
const SRC = "desktop/src-tauri/src";
const LIB = repoPath(`${SRC}/lib.rs`);
const EXIT = repoPath(`${SRC}/exit.rs`);
const MENU = repoPath(`${SRC}/menu.rs`);
const TRAY = repoPath(`${SRC}/tray.rs`);
const WINDOW = repoPath(`${SRC}/window.rs`);
const UPDATER = repoPath(`${SRC}/updater.rs`);

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
}

/** Every Rust file in the shell, read from disk so a new module cannot opt itself out. */
function shellSources(): string[] {
  return readdirSync(repoPath(SRC))
    .filter((entry) => entry.endsWith(".rs"))
    .map((entry) => `${SRC}/${entry}`);
}

describe("desktop exit ownership", () => {
  test("the event loop intercepts the exit request instead of letting it through", () => {
    const lib = code(LIB);
    expect(lib).toContain("RunEvent::ExitRequested");
    expect(lib).toContain("exit::on_exit_requested(app, code, &api)");
  });

  test("no file in the shell kills the runtime process", () => {
    const sources = shellSources();
    expect(sources.length).toBeGreaterThan(10);
    for (const source of sources) {
      expect(code(repoPath(source))).not.toContain(".kill()");
    }
  });

  test("the tray's Quit asks the coordinator rather than ending the process itself", () => {
    const tray = code(TRAY);
    expect(tray).toContain('"quit" => exit::request(app, ExitReason::UserQuit)');
    expect(tray).not.toContain("app.exit(");
  });

  test("the macOS menu's Quit is an ordinary item routed through the gesture path", () => {
    const menu = code(MENU);
    // The predefined item is the one that cannot be held: it calls Cocoa's terminate: directly.
    expect(menu).not.toContain("PredefinedMenuItem::quit");
    expect(menu).toContain('Some("CmdOrCtrl+Q")');
    expect(menu).toContain("crate::exit::gesture(app)");
    // Losing the default menu would take the clipboard items with it, and the failure diagnostic
    // is a block of text the user is asked to copy.
    for (const item of ["cut", "copy", "paste", "select_all"]) {
      expect(menu).toContain(`PredefinedMenuItem::${item}`);
    }
    const lib = code(LIB);
    expect(lib).toContain(".menu(menu::build)");
    expect(lib).toContain("menu::on_event(app, event.id().as_ref())");
  });

  test("a restart is told apart from a quit and keeps its own reason", () => {
    const exit = code(EXIT);
    expect(exit).toContain("ExitReason::CoordinatedRestart");
    expect(exit).toContain("tauri::RESTART_EXIT_CODE");
    const updater = code(UPDATER);
    expect(updater).toContain("exit::request_restart(app)");
    expect(updater).not.toContain("app.restart()");
  });

  test("an update restart drains through the same path a quit does", () => {
    const exit = code(EXIT);
    const restart = exit.indexOf("pub fn request_restart");
    expect(restart).toBeGreaterThan(-1);
    const body = exit.slice(restart, exit.indexOf("\n}", restart));
    expect(body).toContain("start_drain(app, ExitReason::CoordinatedRestart)");
    expect(exit).toContain("sidecar::drain(&proxy, owned, &watch)");
  });

  test("the reason and the drain are claimed in one step", () => {
    const exit = code(EXIT);
    const claim = exit.indexOf("pub fn claim_drain");
    expect(claim).toBeGreaterThan(-1);
    const body = exit.slice(claim, exit.indexOf("\n    }", claim));
    expect(body).toContain("if inner.phase != ExitPhase::Idle");
    expect(body).toContain("inner.reason.get_or_insert(fallback)");
    expect(body).toContain("inner.phase = ExitPhase::Draining");
  });

  test("a runtime is not started once an exit is in flight", () => {
    const exit = code(EXIT);
    expect(exit).toContain("pub fn spawn_unless_ending");
    expect(code(repoPath(`${SRC}/startup.rs`))).toContain("coordinator.spawn_unless_ending(");
  });

  test("the exit is held until the drain reports", () => {
    const exit = code(EXIT);
    for (const arm of [
      "ExitDecision::Hide =>",
      "ExitDecision::Wait =>",
      "ExitDecision::Drain(reason) =>",
      "ExitDecision::Proceed =>",
    ]) {
      expect(exit).toContain(arm);
    }
    const proceed = exit.indexOf("ExitDecision::Proceed =>");
    expect(exit.slice(proceed, proceed + 40)).not.toContain("prevent_exit");
    expect(exit).toContain("coordinator.finish_drain()");
  });

  test("closing the window only hides where there is a tray to come back from", () => {
    const window = code(WINDOW);
    const close = window.indexOf("CloseRequested");
    const branch = window.slice(close, window.indexOf("});", close));
    expect(branch).toContain("if exit::hides_to_tray(app) {");
    expect(branch).toContain("exit::request(app, exit::ExitReason::UserQuit)");
  });

  test("only an observed exit or a refused connection proves the runtime stopped", () => {
    const sidecar = code(repoPath(`${SRC}/sidecar.rs`));
    const start = sidecar.indexOf("async fn gone(");
    expect(start).toBeGreaterThan(-1);
    const body = sidecar.slice(start, sidecar.indexOf("\n}", start));
    expect(body).toContain("watch.exit().is_some()");
    expect(body).toContain("error.is_unreachable()");
    // Any-error-means-gone is the shape this replaces.
    expect(sidecar).not.toContain("proxy.is_alive().await.is_err()");
  });
});
