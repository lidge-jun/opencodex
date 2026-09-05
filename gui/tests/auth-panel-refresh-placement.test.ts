/**
 * Where the Accounts refresh control lives.
 *
 * The control existed, but only at the foot of the account list. Each OAuth account
 * renders a stack of rate-limit bars (5-hour, weekly, and per-model windows such as
 * Fable), so with two accounts the footer sits below the fold: an operator staring at
 * stale bars had to scroll past every one of them to reach the button that re-reads
 * them. It is in the section head now, beside the numbers it refreshes.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/components/provider-workspace/ProviderAuthPanel.tsx", import.meta.url)).text();
// Comments describe the control by name; matching prose is not evidence about code.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = await Bun.file(new URL("../src/styles/provider-workspace-settings.css", import.meta.url)).text();

// There is an earlier `pwi-auth-body` in the Codex-pool branch of this file, so the
// end anchor has to be searched FORWARD from the head, not from the start of the file.
const headStart = src.indexOf('className="pwi-auth-head"');
const head = src.slice(headStart, src.indexOf('className="pwi-auth-body"', headStart));

test("the section head carries the refresh control", () => {
  expect(head).toContain("canRefreshQuota");
  expect(head).toContain("refreshQuota()");
  expect(head).toContain("codexAuth.refreshQuota");
});

test("the head control is disabled while a refresh or account mutation is pending", () => {
  // Two forced reads in flight cancel each other's effect, and a cancelled read never
  // settles its waiters; an account switch would also change the answer mid-flight.
  expect(head).toContain("disabled={refreshingQuota || busy || Boolean(switchingAccountId)}");
});

test("the refresh result is announced exactly once", () => {
  // Both spans would carry role="status", so keeping the footer copy as well would
  // announce one refresh twice.
  const statuses = src.split("quotaRefreshResult && (").length - 1;
  expect(statuses).toBe(1);
});

test("the head control supports logged-in OAuth and API-key rosters behind quota capability", () => {
  expect(head).toContain("((isOauth && loggedIn) || isKeyAuth) && canRefreshQuota");
});

test("the head lays title and control on one wrapping row", () => {
  const start = css.indexOf(".pwi-auth-head {");
  expect(start).toBeGreaterThan(-1);
  const rule = css.slice(start, css.indexOf("}", start));
  expect(rule).toContain("justify-content: space-between");
  // The result string is a full sentence in several locales; it wraps instead of
  // squeezing the title.
  expect(rule).toContain("flex-wrap: wrap");
});
