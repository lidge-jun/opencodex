import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { repoPath } from "../helpers/repo-root";
import { desktopCliPageUrl, openDesktopCliPage } from "../../gui/src/lib/desktop-shell";

const read = (path: string) => readFileSync(repoPath(path), "utf8");
const lib = read("desktop/src-tauri/src/lib.rs");
const policy = read("desktop/src-tauri/src/window.rs");
const page = read("desktop/ui/cli.html");
const script = read("desktop/ui/cli.js");
const commands = ["cli_status", "cli_set_enabled", "cli_install", "cli_remove"];

function commandBody(name: string): string {
  const body = lib.match(new RegExp("(?:async )?fn " + name + "\\([\\s\\S]*?(?=\\n#\\[tauri::command\\]|\\npub fn run)"))?.[0];
  if (!body) throw new Error(`missing native command ${name}`);
  return body;
}

function harness(invoke?: (name: string, args?: unknown) => Promise<unknown>) {
  const handlers = new Map<string, () => void>();
  const nodes = new Map(["enabled", "state", "target", "issues", "error", "repair", "remove", "back", "titlebar"].map(id => [id, {
    checked: false, disabled: false, hidden: false, textContent: "", children: [] as Array<{ textContent: string }>,
    addEventListener: (event: string, callback: () => void) => { handlers.set(`${id}:${event}`, callback); },
    replaceChildren(...items: Array<{ textContent: string }>) { this.children = items; },
  }]));
  const timers = new Map<number, () => void>();
  let poll: () => void = () => {};
  let nextTimer = 0;
  runInNewContext(script, {
    window: { __TAURI__: invoke ? { core: { invoke } } : undefined },
    document: { getElementById: (id: string) => nodes.get(id), createElement: () => ({ textContent: "" }) },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (callback: () => void) => { poll = callback; return 1; }, Promise, Error,
  });
  return { nodes, handlers, timers, poll: () => poll() };
}

async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const configured = { enabled: true, phase: "configured", expectedExecutable: "/example/ocx", issues: [] };
const disabled = { ...configured, enabled: false, phase: "disabled" };

describe("desktop CLI command surface", () => {
  test("registers four path-free commands and guards every wrapper before dispatch", () => {
    const registered = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] || "";
    for (const name of commands) {
      expect(registered).toContain(name);
      const body = commandBody(name);
      const guard = body.indexOf("window::require_cli_page(&window)?");
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.lastIndexOf("cli_command::"));
      expect(body).not.toMatch(/(?:path|command|executable|registry_key):\s*(?:String|PathBuf)/);
    }
    expect(lib).toContain("app.manage(cli_command::State::default())");
    expect(policy).toContain('url.path() == "/cli.html"');
    expect(policy).toContain('window.label() != "main"');
    expect(page).toContain('<script src="cli.js"></script>');
    expect(read("desktop/src-tauri/tauri.conf.json")).toContain('"frontendDist": "../ui"');
  });

  test("Back uses the settings guard while update commands keep their update-only guard", () => {
    expect(commandBody("return_to_dashboard")).toContain("window::require_local_settings_page(&window)?");
    const startup = read("desktop/src-tauri/src/startup.rs");
    const back = startup.match(/fn return_ready_dashboard\([\s\S]*?\n\}/)?.[0] || "";
    expect(back).toContain("dashboard.unwrap_or(");
    expect(back).toContain('"tauri://localhost/index.html"');
    expect(back).toContain('"http://tauri.localhost/index.html"');
    expect(back).toContain('cfg!(target_os = "windows")');
    for (const name of ["update_status", "update_check", "update_install"]) {
      expect(commandBody(name)).toContain("window::require_update_page(&window)?");
    }
    expect(policy).toContain('matches!(url.path(), "/update.html" | "/cli.html")');
    expect(policy).toContain('label == "main"');
    for (const check of ["is_app_origin(url)", "url.username().is_empty()", "url.password().is_none()", "url.query().is_none()", "url.fragment().is_none()"])
      expect(policy).toContain(check);
    expect(script).not.toContain("show_dashboard");
  });

  test("UI sends only a boolean and returns through the existing dashboard command", async () => {
    const calls: Array<[string, unknown]> = [];
    const { nodes, handlers } = harness((name, args) => {
      calls.push([name, args]);
      return Promise.resolve(name === "return_to_dashboard" ? undefined : {
        enabled: true, phase: "configured", expectedExecutable: "/example/ocx", issues: [],
      });
    });
    await settle();
    nodes.get("enabled")!.checked = false;
    handlers.get("enabled:change")!(); await settle();
    handlers.get("repair:click")!(); await settle();
    handlers.get("remove:click")!(); await settle();
    handlers.get("back:click")!(); await settle();
    for (const [name, args] of calls) {
      expect([...commands, "return_to_dashboard"]).toContain(name);
      if (name === "cli_set_enabled") expect(args).toEqual({ enabled: false });
      else expect(args).toBeUndefined();
    }
    for (const name of [...commands, "return_to_dashboard"]) expect(calls.some(([called]) => called === name)).toBe(true);
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(page).not.toMatch(/<input[^>]*type="(?:text|file)"/);
  });

  test("native values stay plain text and missing Tauri disables controls", async () => {
    const unsafe = "<img src=x onerror=alert(1)>";
    const { nodes } = harness(() => Promise.resolve({ enabled: false, phase: "disabled", expectedExecutable: unsafe, issues: [unsafe] }));
    await settle();
    expect(nodes.get("target")!.textContent).toBe("Bundled executable: " + unsafe);
    expect(nodes.get("issues")!.children[0]!.textContent).toBe(unsafe);
    expect(nodes.get("repair")!.disabled).toBe(true);
    const missing = harness().nodes;
    for (const id of ["enabled", "repair", "remove", "back"]) expect(missing.get(id)!.disabled).toBe(true);
    expect(missing.get("state")!.textContent).toContain("Terminal command menu");
  });

  test("native errors and status deadlines remain visible", async () => {
    const rejected = harness(() => Promise.reject(new Error("journal-conflict")));
    await settle();
    expect(rejected.nodes.get("error")!.textContent).toContain("journal-conflict");
    expect(rejected.nodes.get("error")!.hidden).toBe(false);
    const silent = harness(() => new Promise(() => {}));
    expect(silent.timers.size).toBe(1);
    silent.timers.values().next().value!();
    await settle();
    expect(silent.nodes.get("error")!.textContent).toContain("30 seconds");
  });

  for (const outcome of ["result", "error"] as const) {
    test(`a delayed poll ${outcome} cannot overwrite a newer action and queues a fresh status`, async () => {
      const oldPoll = deferred();
      const action = deferred();
      const freshPoll = deferred();
      let statusCalls = 0;
      const ui = harness(name => {
        if (name === "cli_status") {
          statusCalls += 1;
          if (statusCalls === 1) return Promise.resolve(configured);
          return statusCalls === 2 ? oldPoll.promise : freshPoll.promise;
        }
        return action.promise;
      });
      await settle();
      ui.poll();
      ui.handlers.get("remove:click")!();
      action.resolve(disabled);
      await settle();
      expect(ui.nodes.get("enabled")!.checked).toBe(false);
      expect(statusCalls).toBe(2); // the old poll is still in flight
      if (outcome === "result") oldPoll.resolve(configured);
      else oldPoll.reject(new Error("stale-poll-error"));
      await settle();
      expect(ui.nodes.get("enabled")!.checked).toBe(false);
      expect(ui.nodes.get("error")!.hidden).toBe(true);
      expect(statusCalls).toBe(3); // exactly one follow-up after the old poll settles
      freshPoll.resolve({ ...disabled, phase: "partial", issues: ["fresh-status"] });
      await settle();
      expect(ui.nodes.get("state")!.textContent).toContain("Some configuration");
      expect(ui.nodes.get("issues")!.children[0]!.textContent).toBe("fresh-status");
      expect(statusCalls).toBe(3);
      expect(ui.timers.size).toBe(0);
    });
  }

  test("a stale poll error cannot replace the current action error", async () => {
    const oldPoll = deferred();
    const action = deferred();
    let statusCalls = 0;
    const ui = harness(name => name === "cli_status"
      ? (++statusCalls === 1 ? Promise.resolve(configured) : statusCalls === 2 ? oldPoll.promise : Promise.resolve(configured))
      : action.promise);
    await settle();
    ui.poll();
    ui.handlers.get("repair:click")!();
    action.reject(new Error("current-action-error"));
    await settle();
    oldPoll.reject(new Error("stale-poll-error"));
    await settle();
    expect(ui.nodes.get("error")!.textContent).toBe("Error: current-action-error");
    expect(ui.nodes.get("error")!.hidden).toBe(false);
    expect(statusCalls).toBe(3);
  });

  test("ready completion preserves CLI settings during launch and recovery", () => {
    const startup = read("desktop/src-tauri/src/startup.rs");
    expect(startup).toContain("crate::window::shows_cli_page(&window)");
    expect(startup).toContain("|| keeps_update_page(mode, crate::window::shows_update_page(&window))");
    expect(startup).toMatch(/adopt_launch_origin_argument\(app\);\s*crate::cli_command::reconcile_on_launch\(app\);/);
    expect(read("desktop/src-tauri/src/tray.rs")).toContain('"terminal-command" => crate::cli_command::show_page(app)');
  });

  test("dashboard CLI entry is gated by isDesktopShell on every supported OS", () => {
    for (const [platform, url] of [
      ["Macintosh", "tauri://localhost/cli.html"],
      ["X11; Linux", "tauri://localhost/cli.html"],
      ["Windows NT", "http://tauri.localhost/cli.html"],
    ]) {
      expect(desktopCliPageUrl(`Mozilla/5.0 (${platform})`)).toBeNull();
      expect(openDesktopCliPage(`Mozilla/5.0 (${platform})`)).toBe(false);
      expect(desktopCliPageUrl(`Mozilla/5.0 (${platform}) OpenCodexDesktop/2.82.0`)).toBe(url);
    }
    const helpers = read("gui/src/lib/desktop-shell.ts");
    const urlHelper = helpers.match(/export function desktopCliPageUrl\([\s\S]*?\n\}/)?.[0] || "";
    expect(urlHelper).toContain("isDesktopShell(");
    const openHelper = helpers.match(/export function openDesktopCliPage\([\s\S]*?\n\}/)?.[0] || "";
    expect(openHelper).toContain("desktopCliPageUrl(");
    expect(openHelper).toMatch(/if \(!url\) return false/);
  });
});
