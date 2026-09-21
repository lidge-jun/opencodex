// The bootstrap page is the startup surface. It does not probe anything itself: the shell owns the
// sequence, its deadline and its diagnostic, and this page renders what it is told. The phase list
// is asked for rather than written here, so a state added in the shell appears without a second
// edit — and one removed cannot leave a row behind.
//
// What each row shows comes from the shell too, including the states already finished. Rebuilding
// that history from events would be wrong: the first states finish in milliseconds, so a page whose
// listener attached a moment late would show a run in progress with nothing behind it.
//
// Nothing here uses alert, confirm or prompt. The embedded webview implements none of the
// WKUIDelegate panel methods on macOS, so a platform dialog is silently declined and the user sees
// nothing at all. Every message this page has goes into the page — including its own failures,
// because a surface that cannot report is the problem this file exists to fix.

const bridge = window.__TAURI__;
const invoke = bridge && bridge.core && bridge.core.invoke;
const listen = bridge && bridge.event && bridge.event.listen;

const headline = document.querySelector("#headline");
const detail = document.querySelector("#detail");
const phaseList = document.querySelector("#phases");
const failure = document.querySelector("#failure");
const retry = document.querySelector("#retry");
const copy = document.querySelector("#copy");
const copyState = document.querySelector("#copyState");
const diagnostic = document.querySelector("#diagnostic");

const MARKS = { done: "✓", failed: "✕", active: "…", pending: "·" };

let phases = [];

function render(progress) {
  const completed = new Set((progress && progress.completed) || []);
  const failedPhase = (progress && progress.failedPhase) || null;
  const current = progress && progress.phase;
  phaseList.replaceChildren();
  for (const phase of phases) {
    let state = "pending";
    if (phase.id === failedPhase) {
      state = "failed";
    } else if (phase.id === current) {
      state = "active";
    } else if (completed.has(phase.id)) {
      state = "done";
    }
    const row = document.createElement("li");
    row.dataset.state = state;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = MARKS[state];
    const label = document.createElement("span");
    label.textContent = phase.label;
    row.append(mark, label);
    phaseList.append(row);
  }
}

function apply(progress) {
  if (!progress) return;
  headline.textContent = progress.label;
  detail.textContent = progress.detail || "";
  const failed = progress.phase === "failed";
  failure.hidden = !failed;
  retry.disabled = !progress.canRetry;
  if (failed) {
    diagnostic.value = progress.diagnostic || "";
    copyState.textContent = "";
  }
  render(progress);
}

function reportPageFailure(message, error) {
  const cause = error && error.message ? error.message : String(error);
  headline.textContent = "OpenCodex could not read its own startup state.";
  detail.textContent = message;
  failure.hidden = false;
  retry.disabled = false;
  diagnostic.value = [message, cause].join("\n");
}

async function copyDiagnostic() {
  const text = diagnostic.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyState.textContent = "Copied to the clipboard.";
    return;
  } catch {
    // A webview without clipboard access is the reason the text is on screen in the first place.
  }
  diagnostic.focus();
  diagnostic.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  copyState.textContent = copied
    ? "Copied to the clipboard."
    : "The text above is selected — copy it with your keyboard.";
}

retry.addEventListener("click", async () => {
  if (!invoke) return;
  copyState.textContent = "";
  retry.disabled = true;
  try {
    await invoke("retry_startup");
  } catch (error) {
    reportPageFailure("The retry could not be sent to the shell.", error);
  }
});
copy.addEventListener("click", copyDiagnostic);

async function start() {
  if (!invoke || !listen) {
    headline.textContent = "This page is the OpenCodex desktop shell's startup surface.";
    detail.textContent = "Open it from the OpenCodex app.";
    return;
  }
  try {
    phases = (await invoke("startup_phases")).filter((phase) => !phase.terminal);
    render(null);
    // The listener goes on before the snapshot is read, so a transition landing between the two is
    // delivered rather than lost.
    await listen("startup-phase", (event) => apply(event.payload));
    apply(await invoke("startup_snapshot"));
  } catch (error) {
    reportPageFailure("The startup surface could not reach the shell.", error);
  }
}

start();
