/**
 * What the proxy reported about opening a browser for a login it started.
 *
 * `"started"` proves a launcher ran, not that a page rendered; `"failed"` means nothing could be
 * opened on the proxy's machine; `"skipped"` means nothing was tried (a device grant, or an
 * operator who declined the automatic launch). Older servers omit the field entirely.
 */
export type BrowserLaunch = "started" | "failed" | "skipped";

/** Narrow an untrusted response field; anything unexpected reads as unknown. */
export function parseBrowserLaunch(value: unknown): BrowserLaunch | undefined {
  return value === "started" || value === "failed" || value === "skipped" ? value : undefined;
}
