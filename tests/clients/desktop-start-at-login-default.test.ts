import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * A menu bar app that is not running has no menu bar item, so leaving Start at Login off by
 * default means an installed app is simply gone after a reboot. The desktop shell enables it once
 * per installation.
 *
 * The ordering is the whole contract and it is not visible from behaviour alone, so it is read out
 * of the source: the marker is written before the login item is touched, the enable is guarded by
 * the current state, an existing marker returns early, and the tray is built afterwards so its
 * checkbox reflects the result. Get the write order backwards and a user who turns the setting off
 * has it turned back on for them on the next launch.
 *
 * The one-time rewrite that teaches an existing login item to announce itself is the exception, and
 * it writes its marker the other way round on purpose — see the comment on it.
 */
const FIRST_RUN = repoPath("desktop/src-tauri/src/first_run.rs");
const STARTUP = repoPath("desktop/src-tauri/src/startup.rs");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
}

describe("start at login default", () => {
  const firstRun = code(FIRST_RUN);

  test("an existing marker returns before anything is changed", () => {
    const early = firstRun.indexOf("marker.exists()");
    const enable = firstRun.indexOf("autolaunch().enable()");
    expect(early).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(-1);
    expect(early).toBeLessThan(enable);
    expect(firstRun.slice(early, enable)).toContain("return");
  });

  test("the marker is written before the login item is registered", () => {
    const write = firstRun.indexOf("fs::write(&marker");
    const enable = firstRun.indexOf("autolaunch().enable()");
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(enable);
  });

  test("enabling is guarded by the current autolaunch state", () => {
    const guard = firstRun.indexOf("autolaunch().is_enabled()");
    const enable = firstRun.indexOf("autolaunch().enable()");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(enable);
  });

  test("nothing ever deletes the marker", () => {
    expect(firstRun).not.toContain("remove_file");
    expect(firstRun).not.toContain("remove_dir");
  });

  test("it runs before the tray is installed", () => {
    const startup = code(STARTUP);
    const applied = startup.indexOf("first_run::apply_start_at_login_default");
    const tray = startup.indexOf("crate::tray::install");
    expect(applied).toBeGreaterThan(-1);
    expect(tray).toBeGreaterThan(-1);
    expect(applied).toBeLessThan(tray);
  });

  test("the launch-origin rewrite claims its marker only once it has succeeded", () => {
    const start = firstRun.indexOf("pub fn adopt_launch_origin_argument");
    expect(start).toBeGreaterThan(-1);
    const body = firstRun.slice(start);
    const enable = body.indexOf("autolaunch().enable()");
    const claim = body.indexOf("fs::write(&claimed");
    expect(enable).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(enable);
    // It never turns the setting on or off; it only rewrites an entry that is already there.
    expect(body).toContain("Ok(true) =>");
    expect(body).not.toContain("autolaunch().disable()");
  });
});
