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

test("the sidebar foot pairs stop with restart-Codex", () => {
  const row = src.slice(src.indexOf('className="sidebar-action-row"'), src.indexOf("</div>", src.indexOf('className="sidebar-action-orbs"')));
  expect(row).toContain("handleStop");
  expect(row).toContain("handleCodexRestart");
  expect(row).toContain("IconPower");
  expect(row).toContain("IconRefresh");
  // The destructive control keeps its danger marking as an orb.
  expect(row).toContain("sidebar-orb--danger");
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
  const chunks = src.split("<button").slice(1);
  const orbs = chunks.filter(chunk => chunk.slice(0, 400).includes("sidebar-orb"));
  expect(orbs.length).toBeGreaterThanOrEqual(4);
  for (const orb of orbs) expect(orb.slice(0, 400)).toContain("aria-label");
});

test("the restart action comes from the shared hook, not an inline duplicate", () => {
  // The models page reuses the same controller; a second inline implementation
  // would drift on the four-branch message mapping. The hook now also takes an
  // options object, so match the call rather than one exact argument list.
  expect(src).toContain("useCodexRestart(API_BASE");
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

