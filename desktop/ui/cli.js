"use strict";
const invoke = window.__TAURI__?.core?.invoke;
const nodes = Object.fromEntries(["enabled", "state", "target", "issues", "error", "repair", "remove", "back", "titlebar"]
  .map(id => [id, document.getElementById(id)]));
let busy = false;
let latest = null;
let polling = false;
let generation = 0;
let refreshQueued = false;
function controls() {
  nodes.enabled.disabled = busy || !invoke;
  nodes.repair.disabled = busy || !invoke || !latest?.enabled;
  nodes.remove.disabled = busy || !invoke;
  nodes.back.disabled = busy || !invoke;
}
function render(s) {
  latest = s;
  nodes.enabled.checked = Boolean(s.enabled);
  nodes.state.textContent = {
    unobserved: "Configuration has not been inspected yet.",
    configured: "Desktop command configuration is installed. Check selection in a new terminal.",
    partial: "Some configuration could not be applied. Check the issues below.",
    disabled: "Automatic terminal command configuration is off.",
    blocked: "Configuration is blocked. Correct the reported issue and try Repair.",
  }[s.phase] || "Configuration state is unavailable.";
  nodes.target.textContent = s.expectedExecutable ? "Bundled executable: " + s.expectedExecutable : "";
  nodes.issues.replaceChildren(...(s.issues || []).map(code => {
    const li = document.createElement("li"); li.textContent = code; return li;
  }));
  controls();
}
function bounded(work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop did not answer within 30 seconds. Refresh status before retrying.")), 30000);
    Promise.resolve(work).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
async function refresh() {
  if (!invoke || busy || polling) return;
  const request = ++generation;
  polling = true;
  try {
    const s = await bounded(invoke("cli_status"));
    if (request === generation) render(s);
  } catch (e) {
    if (request === generation) { nodes.error.textContent = String(e); nodes.error.hidden = false; }
  } finally {
    polling = false;
    if (refreshQueued) { refreshQueued = false; await refresh(); }
  }
}
async function action(name, args) {
  if (!invoke || busy) return;
  const request = ++generation;
  busy = true; controls(); nodes.error.hidden = true;
  try {
    const s = await bounded(args === undefined ? invoke(name) : invoke(name, args));
    if (request === generation && s) render(s);
  } catch (e) {
    if (request === generation) { nodes.error.textContent = String(e); nodes.error.hidden = false; }
  } finally {
    busy = false; controls();
    if (polling) refreshQueued = true;
    else await refresh();
  }
}
nodes.enabled.addEventListener("change", () => action("cli_set_enabled", { enabled: nodes.enabled.checked }));
nodes.repair.addEventListener("click", () => action("cli_install"));
nodes.remove.addEventListener("click", () => action("cli_remove"));
nodes.back.addEventListener("click", () => action("return_to_dashboard"));
if (invoke && typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent)) {
  nodes.titlebar.hidden = false;
  nodes.titlebar.addEventListener("mousedown", e => {
    if (e.button === 0) invoke("plugin:window|start_dragging").catch(() => {});
  });
  nodes.titlebar.addEventListener("dblclick", () => invoke("plugin:window|toggle_maximize").catch(() => {}));
}
if (!invoke) {
  nodes.state.textContent = "Open this page from OpenCodex Desktop's Terminal command menu.";
  controls();
} else {
  refresh();
  setInterval(refresh, 2000);
}
