import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * INV-DESKTOP-02 — tray availability is an answer from the session, and where there is none the
 * window is shown and closing it quits through the same graceful drain.
 *
 * The pinned Linux backend creates an AppIndicator and reports success without checking that
 * anything will display it, so `TrayIconBuilder::build` returning `Ok` proves nothing. Nor does the
 * watcher merely existing: a StatusNotifierWatcher with no host attached still accepts
 * registrations and still draws nothing, which is why the question asked is the specification's own
 * — is a host registered. On stock GNOME the answer is no, and the shell's macOS-shaped assumptions
 * (a window created hidden, a close that always hides) then left a running process with no way back
 * in. The probe and the branches it feeds are read out of the source because a hosted Linux runner
 * has no graphical session to observe them in.
 */
const SRC = "desktop/src-tauri/src";
const AVAILABILITY = repoPath(`${SRC}/tray_availability.rs`);
const LIB = repoPath(`${SRC}/lib.rs`);
const EXIT = repoPath(`${SRC}/exit.rs`);
const STARTUP = repoPath(`${SRC}/startup.rs`);

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
}

describe("desktop tray availability", () => {
  const availability = code(AVAILABILITY);
  const startup = code(STARTUP);

  test("the probe asks whether a host is registered, not whether a watcher exists", () => {
    expect(availability).toContain('"org.kde.StatusNotifierWatcher"');
    expect(availability).toContain('"IsStatusNotifierHostRegistered"');
    expect(availability).toContain("Connection::new_session()");
    expect(availability).toContain('#[cfg(target_os = "linux")]');
    // A name that merely has an owner is the weaker question this replaces.
    expect(availability).not.toContain("NameHasOwner");
  });

  test("an unanswerable probe is read the same way as a watcher with no host", () => {
    const start = availability.indexOf("pub fn from_host_registered");
    expect(start).toBeGreaterThan(-1);
    const body = availability.slice(start, availability.indexOf("\n}", start));
    expect(body).toContain("Some(true) => TrayAvailability::Available");
    expect(body).toContain("Some(false) | None => TrayAvailability::Unavailable");
  });

  test("nothing is assumed on the platform that needs the probe", () => {
    const start = availability.indexOf("pub fn assumed()");
    expect(start).toBeGreaterThan(-1);
    const body = availability.slice(start, availability.indexOf("\n    }", start));
    expect(body).toContain('cfg!(target_os = "linux")');
    expect(body).toContain("Self::Unavailable");
    // The window can be closed before the probe answers, so the coordinator starts from the
    // platform assumption rather than from optimism.
    expect(code(EXIT)).toContain("TrayAvailability::assumed().hides_to_tray()");
  });

  test("the verdict reaches the coordinator that decides what a close means", () => {
    expect(startup).toContain("coordinator.set_tray(tray)");
    expect(code(EXIT)).toContain("pub fn set_tray(&self, tray: TrayAvailability)");
    expect(code(EXIT)).toContain("pub fn hides_to_tray(app: &AppHandle) -> bool");
  });

  test("no tray icon is claimed where none can be drawn", () => {
    const install = startup.indexOf("crate::tray::install(&handle)");
    expect(install).toBeGreaterThan(-1);
    expect(startup.slice(0, install)).toContain("if tray.is_available() {");
  });

  test("tray availability decides the launch, not the origin of the launch", () => {
    const start = startup.indexOf("pub fn shows_window");
    expect(start).toBeGreaterThan(-1);
    const body = startup.slice(start, startup.indexOf("\n}", start));
    expect(body).toContain("!tray.is_available() || origin == LaunchOrigin::User");
    // The window is shown from inside the sequence, once the verdict is in, so a login launch on a
    // session with no tray is not left hidden with nothing to reopen it from.
    expect(startup).toContain("if shows_window(LaunchOrigin::detect(), tray)");
    expect(code(LIB)).toContain("startup::LaunchOrigin::detect() == startup::LaunchOrigin::User");
  });
});
