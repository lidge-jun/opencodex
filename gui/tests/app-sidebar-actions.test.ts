/**
 * The sidebar's proxy-action row: stop and restart-Codex as paired icon controls.
 *
 * These assert the wiring that a unit test of the transport cannot see — that both
 * surfaces exist, that they carry accessible names, and that the destructive one is
 * still visually marked as destructive after being demoted from a full-width button
 * to a 28px orb.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
// Comments describe the controls by name; matching prose is not evidence about code.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const proxyControls = await Bun.file(new URL("../src/components/ui-v2/proxy-controls.tsx", import.meta.url)).text();
const proxyLever = await Bun.file(new URL("../src/components/ui-v2/proxy-lever.tsx", import.meta.url)).text();

test("the sidebar foot pairs stop with restart-Codex", () => {
  // Design system v2: the sidebar foot renders one ProxyControls card instead of loose orbs.
  const card = src.slice(src.indexOf("<ProxyControls"), src.indexOf("/>", src.indexOf("<ProxyControls")));
  expect(card).toContain("handleStop");
  expect(card).toContain("handleCodexRestart");
  // Both actions live on one lever: the middle notch reloads, the bottom stops. The stop keeps its
  // danger marking: the handle turns red once a pull will stop the proxy on release.
  expect(proxyControls).toMatch(/<ProxyLever [^>]*onRestart=\{onRestart\} onStop=\{onStop\}/);
  expect(proxyLever).toContain('zone === "stop" ? "bg-danger"');
});

test("the mobile top bar carries the same pair", () => {
  // A capability that exists only on desktop is a capability the user cannot find
  // on the surface where the picker is most often noticed as stale.
  const bar = src.slice(src.indexOf('className="mobile-topbar-actions"'), src.indexOf("</div>", src.indexOf('className="mobile-topbar-actions"')));
  expect(bar).toContain("handleStop");
  expect(bar).toContain("handleCodexRestart");
});

test("both controls are disabled while their own action is pending", () => {
  expect(src).toContain("disabled={stopping}");
  expect(src).toContain("disabled={codexRestarting}");
});

test("every action orb carries an accessible name", () => {
  // Icon-only buttons have no text content, so aria-label is the only name.
  // Splitting on the tag start is more robust than matching to a closing angle
  // bracket: arrow functions inside JSX attributes contain ">" themselves.
  const orbs = src.split("<button").slice(1).filter(chunk => chunk.slice(0, 400).includes("sidebar-orb"));
  expect(orbs.length).toBeGreaterThanOrEqual(2);
  for (const orb of orbs) expect(orb.slice(0, 400)).toContain("aria-label");
  // The sidebar card's icon buttons are tray buttons; each call passes a name, and the tray
  // button turns it into the aria-label.
  const buttons = proxyControls.split("<TrayButton ").slice(1);
  expect(buttons.length).toBeGreaterThanOrEqual(1);
  for (const button of buttons) expect(button.slice(0, 400)).toMatch(/\blabel=\{/);
  expect(proxyControls).toContain("aria-label={label}");
  // The lever is named by both of its actions and described by how far to pull for each.
  expect(proxyLever).toContain("aria-label={`${restartLabel} · ${stopLabel}`}");
  expect(proxyLever).toContain("aria-description={hint}");
});

test("the restart action comes from the shared hook, not an inline duplicate", () => {
  // The models page reuses the same controller; a second inline implementation
  // would drift on the four-branch message mapping. The hook now also takes an
  // options object, so match the call rather than one exact argument list.
  expect(src).toContain("useCodexRestart(sharedBase");
  expect(src).not.toContain("requestCodexRestart(");
});

test("the stale full-width stop button markup is gone", () => {
  expect(src).not.toContain('className="theme-toggle stop-toggle"');
});

test("mobile orbs keep a 44px touch target", () => {
  const block = css.slice(css.indexOf(".mobile-topbar-actions"));
  expect(block).toContain("44px");
});


/**
 * Outcome-message and consent assertions. Kept here rather than in a second file so
 * one suite owns the sidebar restart surface.
 */
const hook = await Bun.file(new URL("../src/use-codex-restart.ts", import.meta.url)).text();
const { en } = await import("../src/i18n/en");

test("the restart action is confirm-gated before any request leaves", () => {
  // This can interrupt an in-flight Codex turn. The startup path deliberately
  // refuses to assume that consent; a click is where it is actually given.
  const confirmAt = hook.indexOf("dash.codexRestartConfirm");
  const requestAt = hook.indexOf("requestCodexRestart(");
  expect(confirmAt).toBeGreaterThan(-1);
  expect(requestAt).toBeGreaterThan(confirmAt);
});

test("each response code maps to its own message", () => {
  for (const key of [
    "dash.codexRestartDone",
    "dash.codexRestartNothing",
    "dash.codexRestartUnknown",
    "dash.codexRestartPartial",
  ]) {
    expect(hook).toContain(key);
  }
});

test("the hook reports the code, so a caller can refresh on the nothing_running race", () => {
  // A boolean "stopped" would leave a staleness banner up after nothing_running,
  // which is a SUCCESSFUL outcome.
  expect(hook).toContain("CodexRestartCode | null");
});

test("every restart string exists in the English source with its slots intact", () => {
  for (const key of [
    "dash.actions",
    "dash.codexRestart",
    "dash.codexRestarting",
    "dash.codexRestartConfirm",
    "dash.codexRestartDone",
    "dash.codexRestartNothing",
    "dash.codexRestartUnknown",
    "dash.codexRestartPartial",
    "dash.codexRestartFailed",
    "dash.codexRestartUnreachable",
    "dash.codexRestartMalformed",
  ]) {
    expect(en[key as keyof typeof en]).toBeTruthy();
  }
  expect(en["dash.codexRestartDone"]).toContain("{count}");
  expect(en["dash.codexRestartPartial"]).toContain("{count}");
  expect(en["dash.codexRestartFailed"]).toContain("{status}");
});
