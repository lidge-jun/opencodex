/**
 * Opt-in, NON-DESTRUCTIVE live verification for the Nous Portal provider.
 *
 * This file is skipped unless `NOUS_LIVE_TEST=1` is set. CI runs it only when
 * explicitly opted in. Credentials are sent only to the intended Nous
 * endpoints (the OAuth token endpoint and the inference catalog endpoint) and
 * token values are never printed. It exists to let a reviewer (or the author)
 * prove the real-account refresh path and live catalog discovery against the
 * production Portal.
 *
 * Safety rules (no provider API key is ever shared):
 *  - The refresh token is read ONLY from the local auth store on disk and is
 *    NEVER printed. Only token *lengths* are reported.
 *  - No value derived from a token (access/refresh/JWT) is echoed.
 *  - The refresh runs through the production coordinator
 *    (`refreshGenericAccountWithLock`) — the same generation-aware,
 *    account-lock path production uses — so concurrent refreshes cannot
 *    replay a single-use token. The rotated token is persisted by that path,
 *    so the local session stays valid (non-destructive, review blocker #1).
 *  - It performs a single read-only GET against the live model catalog,
 *    accepting either an OpenAI-style `{ data: [...] }` body or a bare array.
 */
import { describe, expect, test } from "bun:test";
import { getAccountCredential, getAccountSet, getCredential } from "../src/oauth/store";
import { NOUS_INFERENCE_BASE_URL, refreshNousToken } from "../src/oauth/nous";
import { refreshGenericAccountWithLock } from "../src/oauth/index";
import type { OAuthCredentials } from "../src/oauth/types";

const LIVE = process.env.NOUS_LIVE_TEST === "1";

// Redact: report only the kind and length of a secret, never the value.
function len(label: string, v: string | undefined): void {
  if (v === undefined) {
    console.log(`  ${label}: <absent>`);
    return;
  }
  console.log(`  ${label}.len: ${v.length}`);
}

// Minimal refresh-only provider def passed to the coordinator; the coordinator
// owns locking, generation checks, and persistence. (The full OAuthProviderDef
// is private to src/oauth/index.ts and not exported, so use the structural
// subset the coordinator actually consumes.)
const NOUS_DEF: { id: string; refresh: (rt: string, signal?: AbortSignal) => Promise<OAuthCredentials> } = {
  id: "nous",
  refresh: (rt: string, signal?: AbortSignal) => refreshNousToken(rt, signal),
};

describe.skipIf(!LIVE)("Nous Portal live verification (opt-in, no key shared)", () => {
  test("real-account refresh rotates and persists; live catalog is reachable", async () => {
    const stored = getCredential("nous");
    expect(stored?.refresh, "expected a local nous refresh token; set NOUS_LIVE_TEST=1 with a logged-in account").toBeTruthy();
    expect(stored?.accountId, "stored nous credential must carry an accountId").toBeTruthy();
    // The store keys accounts by a hashed row id, not the JWT `sub`; use the row
    // id for account-scoped refresh and read-back.
    const rowId = getAccountSet("nous")?.activeAccountId;
    expect(rowId, "stored nous account set must have an active row id").toBeTruthy();

    console.log("[live] using locally stored nous credential (tokens withheld):");
    len("stored.access", stored!.access);
    len("stored.refresh", stored!.refresh);
    len("stored.accountId", stored!.accountId);

    // Refresh through the production, generation-aware, account-locked
    // coordinator. It refreshes, persists the rotated token, clears the
    // refresh-intent, and returns a usable access token.
    const access = await refreshGenericAccountWithLock(
      "nous",
      rowId!,
      NOUS_DEF,
      stored!,
      {},
    );
    len("refreshed.access", access);
    expect(access.length).toBeGreaterThan(0);

    // Confirm rotation persisted a *different* refresh token (single-use contract).
    const after = getAccountCredential("nous", rowId!);
    len("after.refresh", after?.refresh);
    expect(after?.refresh, "rotation should have persisted a new refresh token").toBeTruthy();
    expect(after!.refresh).not.toBe(stored!.refresh);

    // Read-only live catalog discovery (same endpoint the adapter uses).
    const res = await fetch(`${NOUS_INFERENCE_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    // Parse defensively: only an array body or an object with a `data` array is
    // accepted; anything else (including `{ data: {} }` or `[null]`) becomes an
    // empty list so the length assertion below reports the invalid catalog.
    const models: unknown[] = Array.isArray(body)
      ? body
      : typeof body === "object"
          && body !== null
          && "data" in body
          && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];
    const ids = models.flatMap((model) => {
      if (typeof model !== "object" || model === null) return [];
      const id = (model as { id?: unknown }).id;
      // Reject empty and whitespace-only ids: a catalog of unusable model ids
      // must not satisfy the non-empty assertion below.
      if (typeof id !== "string") return [];
      const normalizedId = id.trim();
      return normalizedId ? [normalizedId] : [];
    });
    console.log(`[live] live catalog returned ${ids.length} models; free tier present: ${ids.some((id) => id.endsWith(":free"))}`);
    expect(ids.length).toBeGreaterThan(0);
  }, 60_000);
});
