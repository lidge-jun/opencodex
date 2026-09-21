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

/** Every Rust file in the shell, walked from disk so a new module cannot opt itself out. */
function shellSources(directory: string = SRC): string[] {
  return readdirSync(repoPath(directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return shellSources(path);
    return entry.name.endsWith(".rs") ? [path] : [];
  });
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
    expect(updater).toContain("crate::exit::prepare_restart(app).await");
    expect(updater).not.toContain("app.restart()");
  });

  test("an update stops the runtime before it replaces anything", () => {
    const updater = code(UPDATER);
    const install = updater.slice(updater.indexOf("pub async fn install("));
    const body = install.slice(0, install.indexOf("\n}"));
    const downloaded = body.indexOf(".download(");
    const prepared = body.indexOf("crate::exit::prepare_restart(app).await");
    const installed = body.indexOf("update.install(package)");
    expect(downloaded).toBeGreaterThan(-1);
    expect(prepared).toBeGreaterThan(downloaded);
    expect(installed).toBeGreaterThan(prepared);
    // The combined call is the shape that cannot drain first.
    expect(body).not.toContain("download_and_install");
    // A drain that did not complete refuses the install rather than proceeding.
    expect(body.slice(prepared, installed)).toContain("if readiness != RestartReadiness::Ready {");
    expect(body.slice(prepared, installed)).toContain("return Err(");
  });

  test("an update restart drains through the same path a quit does", () => {
    const exit = code(EXIT);
    const prepare = exit.indexOf("pub async fn prepare_restart");
    expect(prepare).toBeGreaterThan(-1);
    const body = exit.slice(prepare, exit.indexOf("pub fn complete_restart", prepare));
    expect(body).toContain("claim_drain(ExitReason::CoordinatedRestart)");
    expect(body).toContain("drain_current(app).await");
    expect(body).toContain("coordinator.finish_drain(verdict)");
    expect(exit).toContain("sidecar::drain(&proxy, true, &watch)");
  });

  test("a failed drain is not recorded as a drain, and a restart refuses it", () => {
    const exit = code(EXIT);
    const record = exit.slice(exit.indexOf("pub fn finish_drain("));
    const body = record.slice(0, record.indexOf("\n    }"));
    expect(body).toContain("DrainVerdict::Drained => ExitPhase::Drained");
    expect(body).toContain("DrainVerdict::Failed => ExitPhase::DrainFailed");
    expect(body).toContain("DrainVerdict::OwnershipUnknown => ExitPhase::OwnershipUnknown");
    const rule = exit.slice(exit.indexOf("pub fn decide("), exit.indexOf("struct Inner {"));
    expect(rule).toContain("ExitPhase::DrainFailed | ExitPhase::OwnershipUnknown => match reason");
    expect(rule).toContain("Some(ExitReason::CoordinatedRestart) => ExitDecision::Refuse");
    // A quit still closes the app on one, which is the trade that is defensible.
    expect(rule).toContain("_ => ExitDecision::Proceed");
    // And the refusal is recoverable: the update stayed pending, so the next attempt runs the
    // stop again rather than finding the app permanently unable to try.
    const claim = exit.slice(exit.indexOf("pub fn claim_drain"), exit.indexOf("pub fn finish_drain"));
    expect(claim).toContain("ExitPhase::DrainFailed | ExitPhase::OwnershipUnknown => {");
    expect(claim).toContain("ExitPhase::Draining | ExitPhase::Drained => None,");
  });

  test("stop, quit and update are one execution over one child", () => {
    const tray = code(TRAY);
    expect(tray).toContain("exit::request_stop(app)");
    expect(tray).not.toContain("sidecar::drain");
    const exit = code(EXIT);
    const stop = exit.slice(exit.indexOf("pub fn request_stop("));
    const body = stop.slice(0, stop.indexOf("\n}"));
    expect(body).toContain("coordinator.begin_stop()");
    expect(body).toContain("drain_current(&app).await");
    // A quit that landed during the stop is handed back and run, not dropped.
    expect(body).toContain("coordinator.finish_stop()");
    expect(body).toContain("drain_now(&app, reason)");
  });

  test("the reason and the drain are claimed in one step", () => {
    const exit = code(EXIT);
    const claim = exit.indexOf("pub fn claim_drain");
    expect(claim).toBeGreaterThan(-1);
    const body = exit.slice(claim, exit.indexOf("pub fn finish_drain", claim));
    expect(body.length).toBeGreaterThan(0);
    // One match over the phase, so the reason a caller wins and the move out of Idle cannot be
    // separated by a second caller arriving between them.
    expect(body).toContain("match inner.phase {");
    const idle = body.indexOf("ExitPhase::Idle => {");
    expect(idle).toBeGreaterThan(-1);
    const arm = body.slice(
      idle,
      body.indexOf("ExitPhase::Spawning | ExitPhase::Stopping => {", idle),
    );
    expect(arm).toContain("inner.reason.get_or_insert(fallback)");
    expect(arm).toContain("inner.phase = ExitPhase::Draining;");
    // Nothing else in the file moves the phase to draining.
    expect(exit.split("inner.phase = ExitPhase::Draining;")).toHaveLength(4);
  });

  test("a quit that lands while a runtime is starting is deferred, not lost", () => {
    const exit = code(EXIT);
    // The lock is never held across process creation, so the main thread's exit handler cannot
    // end up waiting on a spawn; the exit is held by the phase instead.
    expect(exit).toContain("ExitPhase::Spawning");
    expect(exit).toContain(
      "ExitPhase::Spawning | ExitPhase::Stopping | ExitPhase::Draining => ExitDecision::Wait",
    );
    const claim = exit.slice(exit.indexOf("pub fn claim_drain"), exit.indexOf("pub fn finish_drain"));
    expect(claim).toContain("ExitPhase::Spawning | ExitPhase::Stopping => {");
    expect(claim).toContain("inner.deferred = true;");
    const finish = exit.slice(
      exit.indexOf("fn finish(&self, phase: ExitPhase)"),
      exit.indexOf("impl Default for ExitCoordinator"),
    );
    expect(finish).toContain("inner.deferred");
    expect(finish).toContain("inner.phase = ExitPhase::Draining;");
    const startup = code(repoPath(`${SRC}/startup.rs`));
    const spawn = startup.slice(startup.indexOf("fn spawn_runtime("));
    expect(spawn).toContain("if !coordinator.begin_spawn() {");
    expect(spawn).toContain("crate::exit::drain_now(app, reason)");
    expect(spawn.indexOf("state.adopt(child)")).toBeLessThan(spawn.indexOf("coordinator.finish_spawn()"));
  });

  test("no tray setter is called while the tray mutex is held", () => {
    const tray = code(repoPath(`${SRC}/tray.rs`));
    // Those setters dispatch to the main thread and wait for it, and the tray is built on the main
    // thread while holding this mutex, so the two together are a cycle.
    expect(tray).toContain("fn menu_handles(app: &AppHandle) -> Option<TrayMenu>");
    // Every setter is reached through the copy, never through a live guard: the nearest thing
    // before it is the handle copy, not the lock.
    const setters = [...tray.matchAll(/\.(?:set_enabled|set_text)\(/g)];
    expect(setters.length).toBeGreaterThan(5);
    for (const setter of setters) {
      const before = tray.slice(0, setter.index);
      expect(before.lastIndexOf("menu_handles(app)")).toBeGreaterThan(
        before.lastIndexOf("menu.lock()"),
      );
    }
  });

  test("the exit is held until the drain reports", () => {
    const exit = code(EXIT);
    const handler = exit.slice(
      exit.indexOf("pub fn on_exit_requested"),
      exit.indexOf("pub fn start_drain"),
    );
    expect(handler.length).toBeGreaterThan(0);
    for (const arm of [
      "ExitDecision::Hide =>",
      "ExitDecision::Wait =>",
      "ExitDecision::Drain(reason) =>",
    ]) {
      const at = handler.indexOf(arm);
      expect(at).toBeGreaterThan(-1);
      expect(handler.slice(at, at + 160)).toContain("api.prevent_exit()");
    }
    const proceed = handler.indexOf("ExitDecision::Proceed =>");
    expect(proceed).toBeGreaterThan(-1);
    expect(handler.slice(proceed)).not.toContain("prevent_exit");
    expect(exit).toContain("coordinator.finish_drain()");
  });

  test("closing the window takes the same decision the quit gesture does", () => {
    const window = code(WINDOW);
    const close = window.indexOf("CloseRequested");
    expect(close).toBeGreaterThan(-1);
    const branch = window.slice(close, window.indexOf("});", close));
    expect(branch).toContain("api.prevent_close()");
    expect(branch).toContain("exit::gesture(");
    const exit = code(EXIT);
    const gesture = exit.slice(exit.indexOf("pub fn gesture("));
    const body = gesture.slice(0, gesture.indexOf("\n}"));
    expect(body).toContain("ExitDecision::Hide => hide_windows(app)");
    expect(body).toContain("ExitDecision::Drain(reason) => start_drain(app, reason)");
  });

  test("a drain never runs against a runtime this app did not start", () => {
    const sidecar = code(repoPath(`${SRC}/sidecar.rs`));
    const drain = sidecar.slice(
      sidecar.indexOf("pub async fn drain("),
      sidecar.indexOf("async fn gone("),
    );
    expect(drain).toContain("if !owned {");
    expect(drain).toContain("return DrainOutcome::NotOwned;");
    expect(drain.indexOf("if !owned {")).toBeLessThan(drain.indexOf("proxy.stop_within("));
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
