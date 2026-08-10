/**
 * Opt-in, NON-DESTRUCTIVE live verification for the Nous Portal provider.
 *
 * This file is skipped unless `NOUS_LIVE_TEST=1` is set, so it never runs in
 * CI and no credential ever travels off the local machine. It exists to let a
 * reviewer (or the author) prove the real-account refresh path and live
 * catalog discovery against the production Portal.
 *
 * Safety rules (no provider API key is ever shared):
 *  - The refresh token is read ONLY from the local auth store on disk and is
 *    NEVER printed. Only token *lengths* are reported.
 *  - No value derived from a token (access/refresh/JWT) is echoed.
 *  - This test REFRESHES and then PERSISTS the rotated token back through the
 *    same `mergeAccountCredential` path production uses, so the local session
 *    stays valid (it is not destructive — review blocker #1).
 *  - It performs a single read-only GET against the live model catalog,
 *    accepting either an OpenAI-style `{ data: [...] }` body or a bare array.
 */
import { describe, expect, test } from "bun:test";
import { getCredential, mergeAccountCredential } from "../src/oauth/store";
import { refreshNousToken } from "../src/oauth/nous";

const LIVE = process.env.NOUS_LIVE_TEST === "1";

// Redact: report only the kind and length of a secret, never the value.
function len(label: string, v: string | undefined): void {
  if (v === undefined) {
    console.log(`  ${label}: <absent>`);
    return;
  }
  console.log(`  ${label}.len: ${v.length}`);
}

describe.skipIf(!LIVE)("Nous Portal live verification (opt-in, no key shared)", () => {
  test("real-account refresh rotates and persists; live catalog is reachable", async () => {
    const stored = getCredential("nous");
    expect(stored?.refresh, "expected a local nous refresh token; set NOUS_LIVE_TEST=1 with a logged-in account").toBeTruthy();
    expect(stored?.accountId, "stored nous credential must carry an accountId").toBeTruthy();

    console.log("[live] using locally stored nous credential (tokens withheld):");
    len("stored.access", stored!.access);
    len("stored.refresh", stored!.refresh);
    len("stored.accountId", stored!.accountId);

    // Refresh against the production Portal. Tokens are read back but redacted.
    const refreshed = await refreshNousToken(stored!.refresh);
    len("refreshed.access", refreshed.access);
    len("refreshed.refresh", refreshed.refresh);
    expect(refreshed.access.length).toBeGreaterThan(0);
    expect(refreshed.refresh.length).toBeGreaterThan(0);
    // Rotation must have produced a different refresh token (single-use contract).
    expect(refreshed.refresh).not.toBe(stored!.refresh);

    // Persist the rotation through the production path so the local session
    // stays valid (non-destructive).
    const result = await mergeAccountCredential("nous", refreshed.accountId ?? stored!.accountId!, refreshed);
    console.log(`[live] rotated token persisted (superseded=${"superseded" in result})`);

    // Read-only live catalog discovery (same endpoint the adapter uses).
    const res = await fetch("https://inference-api.nousresearch.com/v1/models", {
      headers: { Authorization: `Bearer ${refreshed.access}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const models = Array.isArray(body)
      ? (body as Array<{ id?: string }>)
      : ((body as { data?: Array<{ id?: string }> }).data ?? []);
    const ids = models.map((m) => m.id).filter(Boolean) as string[];
    console.log(`[live] live catalog returned ${ids.length} models; free tier present: ${ids.some((id) => id.endsWith(":free"))}`);
    expect(ids.length).toBeGreaterThan(0);
  }, 60_000);
});
