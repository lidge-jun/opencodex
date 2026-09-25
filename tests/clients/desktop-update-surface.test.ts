import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { repoPath } from "../helpers/repo-root";

const read = (path: string) => readFileSync(repoPath(path), "utf8");
const page = read("desktop/ui/update.html");
const lib = read("desktop/src-tauri/src/lib.rs");
const updater = read("desktop/src-tauri/src/updater.rs");
const tray = read("desktop/src-tauri/src/tray.rs");
const windowPolicy = read("desktop/src-tauri/src/window.rs");

function evaluatePage(invoke?: (name: string) => Promise<unknown>) {
  const script = page.match(/<script nonce="__TAURI_SCRIPT_NONCE__">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("update page script missing");
  const handlers = new Map<string, () => void>();
  const nodes = new Map(["state", "error", "check", "install", "back"].map(id => [id, {
    textContent: "", hidden: true, disabled: false,
    addEventListener: (name: string, callback: () => void) => { handlers.set(`${id}:${name}`, callback); },
  }]));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  runInNewContext(script, {
    window: { __TAURI__: invoke ? { core: { invoke } } : undefined },
    document: { querySelector: (selector: string) => nodes.get(selector.slice(1)) },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    Promise, Error,
  });
  return { nodes, timers, handlers };
}

async function settle() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }

describe("bundled desktop update surface", () => {
  test("ships a nonce-bearing app page with only four native commands", () => {
    expect(page).toContain('<script nonce="__TAURI_SCRIPT_NONCE__">');
    for (const command of ["update_status", "update_check", "update_install", "return_to_dashboard"]) {
      expect(page).toContain(`"${command}"`);
      expect(lib).toContain(command);
    }
    expect(page).not.toContain("/api/update/run");
    expect(page).not.toMatch(/\b(?:alert|confirm|prompt)\s*\(/);
  });
  test("keeps install authority on the app page and shares the install claim", () => {
    expect(lib).toContain("window::require_update_page(&window)?");
    expect(windowPolicy).toContain('url.path() == "/update.html"');
    expect(tray).toContain("updater::install_pending(&app).await");
    expect(lib).toContain("updater::install_pending(&app).await");
    expect(tray).toContain("updater::check_and_show(&app).await");
    expect(lib).toContain("updater::check_and_show(&app).await");
    expect(updater).toContain("pub fn claim_install(");
    expect(updater).toContain("compare_exchange(false, true");
    expect(updater).toContain("gate.begin_if_not_installing(&state.installing");
    expect(updater).toContain("gate.apply_if_current(generation");
    expect(updater).toContain("start_ui_projection_worker");
    expect(lib).toContain("async fn update_status(");
    expect(updater).toContain("!gate.epoch_is_current(epoch)");
    expect(updater).toContain("app.state::<CheckGeneration>().inspect(||");
    expect(updater).toContain("= Some(retry_update);");
  });
  test("a page outside Tauri disables updater actions", () => {
    const { nodes } = evaluatePage();
    expect(nodes.get("state")?.textContent).toContain("Open this page from");
    expect(nodes.get("check")?.disabled).toBe(true);
    expect(nodes.get("install")?.disabled).toBe(true);
    expect(nodes.get("back")?.disabled).toBe(true);
  });
  test("a silent native status call becomes a visible retryable error", async () => {
    const { nodes, timers } = evaluatePage(() => new Promise(() => {}));
    expect(timers.size).toBe(1);
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.hidden).toBe(false);
    expect(nodes.get("error")?.textContent).toContain("did not answer within 5000 ms");
    expect(nodes.get("check")?.disabled).toBe(false);
  });
  test("a silent native check reports its 60 second deadline", async () => {
    const status = { currentVersion: "2.65.0", latestVersion: null, available: false, installing: false, checking: false };
    const { nodes, timers, handlers } = evaluatePage(name =>
      name === "update_status" ? Promise.resolve(status) : new Promise(() => {}));
    await settle();
    handlers.get("check:click")?.();
    expect(timers.size).toBe(1);
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.textContent).toContain("60000 ms");
  });
  test("an install timeout re-reads a still-held native claim", async () => {
    let installing = false;
    const status = { currentVersion: "2.65.0", latestVersion: "2.66.0", available: true, installing: false, checking: false };
    const { nodes, timers, handlers } = evaluatePage(name => {
      if (name === "update_status") return Promise.resolve({ ...status, installing });
      if (name === "update_install") { installing = true; return new Promise(() => {}); }
      return Promise.reject(new Error("unexpected command"));
    });
    await settle();
    handlers.get("install:click")?.();
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.textContent).toContain("600000 ms");
    expect(nodes.get("install")?.disabled).toBe(true);
  });
  test("a page check superseded by a tray check stays checking until the tray result settles", async () => {
    const current = { currentVersion: "2.65.0", latestVersion: null, available: false, installing: false, checking: false };
    const checking = { ...current, checking: true };
    const trayResult = { ...current, latestVersion: "2.66.0", available: true };
    let nativeStatus = current;
    const { nodes, timers, handlers } = evaluatePage(name => {
      if (name === "update_check") { nativeStatus = checking; return Promise.resolve(checking); }
      if (name === "update_status") return Promise.resolve(nativeStatus);
      return Promise.reject(new Error("unexpected command"));
    });
    await settle();
    handlers.get("check:click")?.();
    await settle();
    expect(nodes.get("state")?.textContent).toBe("Checking for updates…");
    expect(nodes.get("state")?.textContent).not.toContain("up to date");
    nativeStatus = trayResult; // the newer tray/background generation completes
    const timer = [...timers.entries()][0];
    if (!timer) throw new Error("checking status did not schedule a poll");
    const [pollId, poll] = timer;
    timers.delete(pollId);
    poll();
    await settle();
    expect(nodes.get("state")?.textContent).toContain("Update v2.66.0 is available");
    expect(nodes.get("install")?.disabled).toBe(false);
    expect(timers.size).toBe(0);
  });
});
