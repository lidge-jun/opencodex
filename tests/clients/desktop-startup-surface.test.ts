import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * The startup surface exists before the work it reports on.
 *
 * Discovery, the liveness probe, the sidecar spawn and the health wait all used to run inside
 * `setup()`, and the window was created hidden afterwards. Every failure in that stretch was
 * therefore invisible: the spawn event stream was destructured into `_events` and dropped, so the
 * child's exit code went with it, and a run of probes that time out rather than refuse takes over a
 * minute with nothing on screen. Ordering is the whole of the fix, and a state that reports work
 * already finished elsewhere is not a state — it is a label. Both are read out of the source.
 */
const SRC = "desktop/src-tauri/src";
const LIB = repoPath(`${SRC}/lib.rs`);
const SIDECAR = repoPath(`${SRC}/sidecar.rs`);
const STARTUP = repoPath(`${SRC}/startup.rs`);
const PROXY = repoPath(`${SRC}/proxy.rs`);
// The startup surface is one file: the page and its script ship together in index.html,
// because a script loaded from a second file is not named by the policy the webview is
// actually served and never runs on some platforms. Read the page as the oracle for both.
const PAGE = repoPath("desktop/ui/index.html");
const CONFIG = repoPath("desktop/src-tauri/tauri.conf.json");

function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("desktop startup surface", () => {
  const lib = code(LIB);
  const startup = code(STARTUP);

  test("the window is built and shown before the sequence that reports into it", () => {
    const setup = lib.indexOf(".setup(|app|");
    expect(setup).toBeGreaterThan(-1);
    const built = lib.indexOf("WebviewWindowBuilder::new", setup);
    const shown = lib.indexOf("window::show(&window)", setup);
    const begun = lib.indexOf("startup::begin(app.handle())", setup);
    expect(built).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(built);
    expect(begun).toBeGreaterThan(shown);
  });

  test("setup resolves nothing, registers nothing and starts nothing", () => {
    const setup = lib.slice(
      lib.indexOf(".setup(|app|"),
      lib.indexOf(".build(tauri::generate_context!())"),
    );
    expect(setup.length).toBeGreaterThan(0);
    for (const call of [
      "block_on",
      "ensure_proxy",
      "resolve::run",
      "ProxyClient::new",
      "tray_availability::detect()",
      "tray::install",
      "first_run::",
      "sidecar::",
    ]) {
      expect(setup).not.toContain(call);
    }
  });

  test("resolving and registering are states that own their work", () => {
    expect(startup).toContain("Phase::Resolving");
    // D5: the shell asks the bundled CLI rather than reading a port record and guessing.
    expect(startup).toContain("resolve::run(app, deadline).await");
    expect(startup).toContain("ProxyClient::new(endpoint");
    expect(startup).toContain("Phase::Registering");
    expect(startup).toContain("tray_availability::detect");
    expect(startup).toContain("first_run::apply_start_at_login_default(app)");
    expect(startup).toContain("crate::tray::install(&handle)");
  });

  test("the app's own surface is registered before the runtime is touched", () => {
    const registering = startup.indexOf("Phase::Registering, None)");
    const resolving = startup.indexOf("Phase::Resolving, None)");
    const starting = startup.indexOf("Phase::Starting, None)");
    expect(registering).toBeGreaterThan(-1);
    expect(resolving).toBeGreaterThan(registering);
    expect(starting).toBeGreaterThan(resolving);
  });

  test("the spawn event stream is consumed rather than discarded", () => {
    const sidecar = code(SIDECAR);
    expect(sidecar).not.toContain("_events");
    expect(sidecar).toContain("let (events, child) = command.spawn()");
    expect(sidecar).toContain("watch.follow(events)");
    expect(sidecar).toContain("CommandEvent::Terminated(payload)");
  });

  test("the child's exit code is what ends the wait early", () => {
    const wait = startup.indexOf("Phase::Waiting, None);");
    expect(wait).toBeGreaterThan(-1);
    const loop = startup.slice(wait, startup.indexOf("async fn register(", wait));
    expect(loop).toContain("watch.exit()");
    expect(loop).toContain("exit.describe()");
  });

  test("one deadline covers the whole sequence and bounds every probe under it", () => {
    expect(startup).toContain("pub const DEADLINE: Duration");
    expect(startup).toContain("let deadline = started + DEADLINE;");
    // The budget for finding an existing runtime is the CLI's now, not a second one here: the
    // tuned probe budgets exist because a shell-side reimplementation answered "nobody is
    // listening" twice and started duplicate proxies.
    expect(startup).not.toContain("ATTACH_BUDGET");
    expect(startup).not.toContain("fn healthy_by");
    expect(startup).toContain("resolve::run(app, deadline).await");
    // A probe bounded only by the client's own timeout overruns whatever budget it was started
    // under, which is how a stated ceiling becomes an unstated one.
    expect(startup).not.toContain("proxy.is_alive()");
    expect(startup).toContain("proxy.alive_within(deadline)");
    // Registration waits on a session bus and on the main thread, and both can stall; neither is
    // allowed to leave the page in a state whose retry could do nothing.
    expect(startup).toContain("tokio::time::timeout_at(\n        deadline,");
    expect(startup).toContain("tokio::time::timeout_at(deadline, receiver)");
    const proxy = code(PROXY);
    expect(proxy).toContain("timeout_at(deadline, self.is_alive())");
    // The stop is the bundled CLI's now, under its own deadline.
    const stop = code(repoPath("desktop/src-tauri/src/runtime_stop.rs"));
    expect(stop).toContain("timeout_at(deadline, command.output())");
    expect(stop).toContain("pub const DEADLINE: Duration");
  });

  test("a retry waits on the child it already started rather than starting a second one", () => {
    expect(startup).toContain("&& watch.exit().is_none()");
    const guard = startup.indexOf("if owns_live_child {");
    const spawn = startup.indexOf("sidecar::start(app, endpoint, watch)");
    expect(guard).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(guard);
  });

  test("the diagnostic names the state, the endpoint, the home and how the child ended", () => {
    const start = startup.indexOf("pub fn diagnostic(");
    expect(start).toBeGreaterThan(-1);
    const body = startup.slice(start, startup.indexOf("fn report(", start));
    for (const field of [
      "state:",
      "reason:",
      "elapsed:",
      "endpoint:",
      "home:",
      "runtime process:",
      "runtime output",
    ]) {
      expect(body).toContain(field);
    }
    expect(body).toContain("exit.describe()");
  });

  test("the snapshot carries the finished states, not just the current one", () => {
    expect(startup).toContain("pub completed: Vec<&'static str>");
    expect(startup).toContain("pub failed_phase: Option<&'static str>");
    const page = readFileSync(PAGE, "utf8");
    expect(page).toContain("progress.completed");
    expect(page).toContain("progress.failedPhase");
  });

  test("the snapshot answers with a state rather than with nothing", () => {
    // The page returns early on a falsy progress, so an absent answer was not a neutral one: it
    // was a window frozen on its own markup, with no diagnostic in it and no event coming.
    expect(lib).toContain("fn startup_snapshot(app: tauri::AppHandle) -> startup::Progress");
    expect(lib).not.toContain("Option<startup::Progress>");
    expect(lib).toContain("unwrap_or_else(startup::unavailable)");
    expect(startup).toContain("pub fn unavailable() -> Progress");
  });

  test("not having started is a state of its own, and not a checklist row", () => {
    // Seeding the state with the first phase made "has not started" render exactly like "started,
    // and registering". A row for it would instead be a step that never completes.
    expect(startup).toContain('Self::NotStarted => "not-started"');
    const list = startup.indexOf("pub const PHASES");
    expect(list).toBeGreaterThan(-1);
    expect(startup.slice(list, startup.indexOf("];", list))).not.toContain("NotStarted");
    expect(startup).not.toContain("Progress::new(Phase::Registering, 0)");
  });

  test("the run publishes before anything it does can return", () => {
    // The lookup below used to come first, so a run that returned there had said nothing at all
    // and the page could not tell that from a run still going.
    const at = startup.indexOf("async fn run(app: &AppHandle");
    expect(at).toBeGreaterThan(-1);
    const body = startup.slice(at, startup.indexOf("async fn register(", at));
    const published = body.indexOf("report(app, started, Phase::Registering, None);");
    expect(published).toBeGreaterThan(-1);
    expect(body.indexOf("try_state::<AppState>()")).toBeGreaterThan(published);
  });

  test("a run that reports nothing is still a run that ends", () => {
    // Every early return in the sequence, and every step that outlives the ceiling, used to leave
    // the surface on its last state for as long as the process lived.
    const begin = startup.slice(startup.indexOf("pub fn begin("), startup.indexOf("fn settle("));
    expect(begin).toContain("run(&app, started).await;");
    expect(begin.slice(begin.indexOf("run(&app, started).await;"))).toContain("settle(");
    expect(begin).toContain("sleep_until(started + DEADLINE + SETTLE_GRACE)");
    // Idempotent, and bound to the run it was started for: it may not overwrite a real result,
    // and a guard left over from an earlier run may not fail the retry that replaced it.
    const settle = startup.slice(startup.indexOf("fn settle("), startup.indexOf("async fn run("));
    expect(settle).toContain("startup.settled()");
    expect(settle).toContain("generation.load(Ordering::Acquire) != generation");
    expect(settle).toContain("Progress::new(Phase::Failed, elapsed_ms)");
  });

  test("the retry, the snapshot and the phase list are reachable from the page", () => {
    const handler = lib.slice(
      lib.indexOf("generate_handler!["),
      lib.indexOf("])", lib.indexOf("generate_handler![")),
    );
    for (const command of ["startup_snapshot", "startup_phases", "retry_startup"]) {
      expect(lib).toContain(`fn ${command}(`);
      expect(handler).toContain(command);
    }
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).app.withGlobalTauri).toBe(true);
  });

  test("the page derives its phases instead of restating them", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(page).toContain('invoke("startup_phases")');
    expect(page).toContain('invoke("startup_snapshot")');
    expect(page).toContain('invoke("retry_startup")');
    expect(page).toContain('listen("startup-phase"');
    for (const phase of ["resolving", "probing", "attaching", "starting", "waiting", "registering"]) {
      expect(page).not.toContain(`"${phase}"`);
    }
  });

  test("every call into the shell can fail without leaving the page blank", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(page).toContain("function reportPageFailure");
    // Both entry points — the first load and the retry — have to catch, because either one
    // failing silently leaves a window that says "Starting…" forever.
    expect(page.match(/reportPageFailure\(/g) || []).toHaveLength(3);
    const retry = page.slice(page.indexOf('retry.addEventListener'));
    expect(retry.slice(0, 400)).toContain("catch");
  });

  test("the page never reaches for a dialog the webview cannot draw", () => {
    const page = readFileSync(PAGE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The call form, not the word: a method on a receiver or a property of that name is fine.
    expect(page).not.toMatch(/(^|[^.\w$])(?:window\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/);
    expect(page).toContain("#diagnostic");
    expect(page).toContain("clipboard.writeText");
  });
});

/**
 * The surface has to be able to stay silent.
 *
 * Two defects made it speak when it had nothing to say and stay quiet when it did. An id rule
 * with display: grid outranks the user-agent [hidden] { display: none } rule, so the failure
 * block - the Retry button and the empty diagnostic box - was painted during every normal start.
 * And an invoke whose command never answers returns a promise that neither settles nor rejects,
 * so the page kept its initial markup for as long as the shell stayed silent. Together they are
 * the screen a user reads as a dead application: a starting headline, no checklist, one Retry.
 */
describe("the bootstrap page reports only what it was told", () => {
  const markup = readFileSync(repoPath("desktop/ui/index.html"), "utf8");
  const page = readFileSync(PAGE, "utf8");

  test("the failure block honours its hidden attribute", () => {
    expect(/#failure\[hidden\][^{]*\{[^}]*display:\s*none/.test(markup)).toBe(true);
  });

  test("the bootstrap script carries the nonce token the shell replaces", () => {
    // The webview is served a policy the configuration file does not contain. Tauri appends its
    // own hashes and nonces to script-src, and a hash or nonce in that directive makes
    // 'unsafe-inline' inert, so nothing loads unless it is named. Its injector only tags
    // script[src^='http'], and this page loads its script by relative path, so the page has to
    // carry the token itself; the shell replaces it with a real nonce and adds that nonce to the
    // directive. Without it the surface renders as static markup on the platforms where the
    // asset origin does not satisfy 'self' — observed on Linux, where the page never ran a line.
    expect(markup).not.toContain("./main.js");
    expect(markup).toMatch(/<script nonce="__TAURI_SCRIPT_NONCE__">/);
  });

  test("the handshake with the shell is bounded", () => {
    expect(page).toContain("HANDSHAKE_DEADLINE_MS");
    for (const command of ["startup_phases", "startup_snapshot"]) {
      const bounded = 'withDeadline(invoke(\"' + command + '\")';
      expect(page.includes(bounded)).toBe(true);
    }
    expect(page).toContain("withDeadline(listen(");
  });
});
