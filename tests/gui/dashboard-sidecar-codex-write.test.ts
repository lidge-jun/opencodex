/**
 * The Dashboard's half of the web-search switch.
 *
 * The sidecar state is stored even when Codex's own `web_search` key was not rewritten, so the card
 * has to say so instead of implying the native tool is already gone. The `not_requested` answer is
 * the ordinary "nothing moved" case and must stay silent: a warning there would fire on every save
 * that leaves the switch alone, which is most of them.
 */
import { expect, test } from "bun:test";
import { nextSidecarCodexApply, sidecarCodexWritePending } from "../../gui/src/pages/dashboard-shared";

test("a refused Codex-config write is reported as pending, whatever the reason", () => {
  expect(sidecarCodexWritePending({ applied: false, reason: "write_lock_busy", retryable: true })).toBe(true);
  expect(sidecarCodexWritePending({ applied: false, reason: "proxy_not_running", retryable: true })).toBe(true);
  expect(sidecarCodexWritePending({ applied: false, reason: "injection_refused", retryable: false })).toBe(true);
});

test("an applied write and the ordinary no-op answer stay silent", () => {
  expect(sidecarCodexWritePending({ applied: true })).toBe(false);
  expect(sidecarCodexWritePending({ applied: false, reason: "not_requested", retryable: false })).toBe(false);
});

test("an older server that omits the report never warns", () => {
  expect(sidecarCodexWritePending(undefined)).toBe(false);
});

test("a save that did not move the switch cannot clear an outstanding failure", () => {
  const refused = { applied: false, reason: "proxy_not_running", retryable: true };
  const untouched = { applied: false, reason: "not_requested", retryable: false };
  // Saving a Vision setting while the web-search write is still outstanding: the server answers
  // about the file it never touched, and the warning has to survive that answer.
  expect(nextSidecarCodexApply(refused, untouched)).toBe(refused);
  expect(nextSidecarCodexApply(refused, refused)).toBe(refused);
  // A write that ran settles the question, in both directions, and so does a sync (which clears
  // the report by passing undefined).
  expect(nextSidecarCodexApply(refused, { applied: true })).toEqual({ applied: true });
  expect(nextSidecarCodexApply(refused, undefined)).toBeUndefined();
  expect(nextSidecarCodexApply(undefined, untouched)).toBe(untouched);
});
