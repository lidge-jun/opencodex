import type { OpenUrlResult } from "./open-url";

/**
 * The one sentence a terminal login says when nothing opened.
 *
 * Stated once because it is now said from three places — the Codex account login, the generic
 * OAuth login and the key login — and a sentence restated three times drifts three ways. Callers
 * that have something more specific to add append to it rather than rewriting it, so the part a
 * user learns to recognize stays identical everywhere.
 */
export const BROWSER_LAUNCH_FAILED_NOTICE =
  "⚠️  No browser could be opened here — open the URL above yourself.";

/**
 * Report a browser launch whose answer arrives after the code that started it has moved on.
 *
 * The OAuth controller does not await `onAuth`, so a CLI login cannot simply await the launcher
 * there: the flow continues, and on a callback-server provider the very next thing it does is
 * draw a readline prompt. A warning written at that moment lands on the line the user is typing
 * on, which is worse than not warning at all.
 *
 * So the launch reports itself as soon as it settles, and anything that would collide with it
 * waits on {@link BrowserLaunchReport.settled} first. The launcher answers within its own settle
 * window, so the wait costs a fraction of a second and buys a deterministic order.
 */
export interface BrowserLaunchReport {
  /** Adopt a launch already in flight. Its failure is reported once, when it settles. */
  track(launch: Promise<OpenUrlResult>): void;
  /**
   * Resolves once every launch tracked BEFORE this call has been reported, and immediately when
   * none was. A login publishes one URL, so "before this call" and "at all" are the same set
   * here; the narrower promise is the one this actually keeps.
   */
  settled(): Promise<void>;
}

export function createBrowserLaunchReport(
  warn: (message: string) => void = message => { console.warn(message); },
): BrowserLaunchReport {
  let pending: Promise<void> = Promise.resolve();
  return {
    track(launch) {
      pending = pending
        .then(() => launch)
        .then(
          result => {
            if (result.status !== "started") warn(`\n${BROWSER_LAUNCH_FAILED_NOTICE}`);
          },
          // openUrl is documented never to reject, and a launcher that did would mean the same
          // thing as one that failed. Swallowing it here is not politeness: this chain is what
          // `settled()` hands to a prompt, so a rejection would propagate out of a login that
          // is still perfectly able to continue, and would go unhandled in the polling flows
          // that do not reach that await until minutes later.
          () => { warn(`\n${BROWSER_LAUNCH_FAILED_NOTICE}`); },
        );
    },
    settled: () => pending,
  };
}
