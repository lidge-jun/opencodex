import { beforeEach, describe, expect, test } from "bun:test";
import {
  availableAccountGatedNativeModels,
  cachedAvailableAccountGatedNativeModels,
  entitledCodexAccountIdsForModel,
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  isDirectCallerEntitledToCodexModel,
  isUsableCodexClientVersion,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexEntitlementClientVersion,
  resolveCodexModelEntitlements,
  seedCodexModelEntitlementsForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../src/codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import upstreamModelsSnapshot from "../src/codex/data/upstream-models.json";

const TEST_CLIENT_VERSION = "0.146.0";
const DAYBREAK = "gpt-daybreak-blue-latest";
const SOL = "gpt-5.6-sol";
const TERRA = "gpt-5.6-terra";
const LUNA = "gpt-5.6-luna";

function credential(accountId: string): CodexModelEntitlementCredentialSnapshot {
  return {
    accountId,
    accessToken: `token-${accountId}`,
    chatgptAccountId: `chatgpt-${accountId}`,
    credentialIdentity: `test:${accountId}`,
  };
}

function roster(...slugs: string[]): Response {
  return Response.json({
    models: slugs.map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
  });
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

describe("Codex account model entitlements", () => {
  test("keeps account-gated models scoped to the authenticated account roster", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main"), credential("secondary")],
      fetcher: (async (_input, init) => {
        const accountId = new Headers(init?.headers).get("chatgpt-account-id");
        return accountId === "chatgpt-main"
          ? roster(SOL, LUNA, DAYBREAK)
          : roster(SOL, TERRA);
      }) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    expect([...entitledCodexAccountIdsForModel(snapshot, DAYBREAK)!]).toEqual(["main"]);
    expect([...entitledCodexAccountIdsForModel(snapshot, SOL)!]).toEqual(["main", "secondary"]);
    expect([...entitledCodexAccountIdsForModel(snapshot, TERRA)!]).toEqual(["secondary"]);
    expect([...entitledCodexAccountIdsForModel(snapshot, LUNA)!]).toEqual(["main"]);
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([SOL, TERRA, LUNA, DAYBREAK]);
  });

  test("fails closed when an account roster cannot be confirmed", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("broken")],
      fetcher: (async () => new Response("not-json", { status: 502 })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    expect(snapshot.confirmedAccountIds.size).toBe(0);
    expect(entitledCodexAccountIdsForModel(snapshot, DAYBREAK)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).size).toBe(0);
  });

  test("ignores hidden or API-disabled rows", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => Response.json({ models: [
        { slug: DAYBREAK, supported_in_api: true, visibility: "hide" },
        { slug: "gpt-disabled", supported_in_api: false, visibility: "list" },
      ] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    expect(snapshot.confirmedAccountIds.has("main")).toBe(true);
    expect(entitledCodexAccountIdsForModel(snapshot, DAYBREAK)?.size).toBe(0);
  });

  test("filters excluded accounts before credential and roster access", async () => {
    const credentialReads: string[] = [];
    const fetchedAccounts: string[] = [];
    const snapshot = await resolveCodexModelEntitlements({
      codexAccounts: [
        { id: "pool-b", email: "pool-b@example.test", isMain: false },
      ],
    }, {
      excludeAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]),
      credentialSnapshot: async (accountId) => {
        credentialReads.push(accountId);
        return credential(accountId);
      },
      fetcher: (async (_input, init) => {
        fetchedAccounts.push(new Headers(init?.headers).get("chatgpt-account-id") ?? "");
        return roster(DAYBREAK);
      }) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    expect(credentialReads).toEqual(["pool-b"]);
    expect(fetchedAccounts).toEqual(["chatgpt-pool-b"]);
    expect([...snapshot.modelsByAccount.keys()]).toEqual(["pool-b"]);
    expect(snapshot.confirmedAccountIds.has(MAIN_CODEX_ACCOUNT_ID)).toBe(false);

    const supplied = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential(MAIN_CODEX_ACCOUNT_ID), credential("pool-c")],
      excludeAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]),
      fetcher: (async () => roster(DAYBREAK)) as typeof fetch,
      now: 2_000,
    });
    expect([...supplied.modelsByAccount.keys()]).toEqual(["pool-c"]);
  });

  test("checks a Direct caller's own bearer instead of a local Pool account", async () => {
    let seenAuthorization = "";
    let seenAccount = "";
    const entitled = await isDirectCallerEntitledToCodexModel(
      new Headers({
        authorization: "Bearer caller-token",
        "chatgpt-account-id": "caller-account",
      }),
      DAYBREAK,
      {
        fetcher: (async (_input, init) => {
          const headers = new Headers(init?.headers);
          seenAuthorization = headers.get("authorization") ?? "";
          seenAccount = headers.get("chatgpt-account-id") ?? "";
          return roster("gpt-5.6-sol", DAYBREAK);
        }) as typeof fetch,
        now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
      },
    );

    expect(entitled).toBe(true);
    expect(seenAuthorization).toBe("Bearer caller-token");
    expect(seenAccount).toBe("caller-account");
  });

  test("Direct entitlement fails closed on an unconfirmed roster", async () => {
    await expect(isDirectCallerEntitledToCodexModel(
      new Headers({ authorization: "Bearer caller-token" }),
      DAYBREAK,
      {
        fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
        now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
      },
    )).resolves.toBe(false);
  });

  test("Direct-caller rosters do not evict main/Pool entitlement evidence", async () => {
    // The catalog projects ONLY from main/Pool keys. Under a single shared LRU, a burst of
    // distinct Direct callers pushed those out and the gated row vanished from the catalog until
    // rediscovery — fail-closed flapping whose cause an operator cannot see.
    seedCodexModelEntitlementsForTests("main", [DAYBREAK], 1_000);
    expect([...cachedAvailableAccountGatedNativeModels(1_000)]).toContain(DAYBREAK);

    // Far more distinct Direct callers than the per-class cache bound of 64.
    for (let i = 0; i < 80; i += 1) {
      await isDirectCallerEntitledToCodexModel(
        new Headers({ authorization: `Bearer caller-${i}` }),
        DAYBREAK,
        { fetcher: (async () => roster(DAYBREAK)) as typeof fetch, now: 1_000 },
      );
    }

    // With one shared 64-entry LRU this read came back empty. The main grant is a different
    // eviction class and is still inside its TTL, so it must survive.
    expect([...cachedAvailableAccountGatedNativeModels(1_000)]).toContain(DAYBREAK);
  });

});

describe("entitlement client version (#2886)", () => {
  /**
   * Upstream filters this roster by the client version it is told, and `client_version` is a
   * required parameter — a measured 0.60.0 returns zero models where 0.142.2 returns five
   * (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md). Asking as
   * 0.0.0 therefore describes what a prehistoric client may use, and the fail-closed gate
   * added by #2550 turned that into "this account cannot use GPT-5.6" for an account that
   * demonstrably can.
   */
  function versionFilteredBackend(seen: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const version = url.searchParams.get("client_version") ?? "";
      seen.push(version);
      const major = Number(version.split(".")[1] ?? "0");
      // Below the GPT-5.6 threshold upstream simply omits those rows.
      return major >= 144 ? roster("gpt-5.5", SOL, TERRA, LUNA) : roster("gpt-5.5");
    }) as typeof fetch;
  }

  test("an entitled account keeps GPT-5.6 when the real runtime version is reported", async () => {
    const seen: string[] = [];
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: versionFilteredBackend(seen),
      now: 1_000,
      clientVersion: "0.146.0",
    });

    expect(seen).toEqual(["0.146.0"]);
    // The wrong behavior: an entitled account classified as denying GPT-5.6 because
    // OpenCodex under-reported its own client version.
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([SOL, TERRA, LUNA]);
    expect(snapshot.confirmedAccountIds.has("main")).toBe(true);
  });

  test("no request and no runtime still asks under this build's own gated floor", async () => {
    // Background catalog sync has no inbound request and, on a host where Codex has never
    // been resolved, no persisted runtime either — yet it is the path that publishes
    // account-confirmed native rows. An earlier revision of this fix skipped discovery in
    // that state, which suppressed exactly the rows the fix exists to restore
    // (tests/claude-models-discovery.test.ts and tests/codex-catalog-sync-hardening.test.ts
    // both failed on it). The last tier therefore has to be a real, answerable version.
    expect(resolveCodexEntitlementClientVersion(null, () => null))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    const seen: string[] = [];
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      // Gates exactly at the version the bundled snapshot declares for the gated models, so
      // this asserts the floor is *sufficient* to return them rather than re-testing the
      // arbitrary threshold the other backend uses.
      fetcher: (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const version = url.searchParams.get("client_version") ?? "";
        seen.push(version);
        const minor = Number(version.split(".")[1] ?? "0");
        return minor >= 142 ? roster("gpt-5.5", SOL, TERRA, LUNA) : roster("gpt-5.5");
      }) as typeof fetch,
      now: 1_000,
      clientVersion: null,
      // Both of the first two tiers unusable: no inbound version, no selected runtime.
      loadPersistedRuntime: () => null,
    });

    // The floor is asked verbatim — not `0.0.0`, and not skipped.
    expect(seen).toEqual([GATED_MODEL_CLIENT_VERSION_FLOOR]);
    expect(snapshot.confirmedAccountIds.has("main")).toBe(true);
    // Read the SNAPSHOT, not the process-wide cache: another suite in the same run can leave
    // a confirmed entry behind, and this assertion is about what this discovery pass proved.
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([SOL, TERRA, LUNA]);
    expect(snapshot.modelsByAccount.has("main")).toBe(true);
  });

  test("the gated floor is derived from the bundled roster, not written by hand", () => {
    // If the snapshot is refreshed with a model requiring a newer client, the floor must
    // follow it; a hand-copied constant would silently under-ask forever.
    const rows = (upstreamModelsSnapshot as { models?: Array<Record<string, unknown>> }).models ?? [];
    const gatedFloors = rows
      .filter(row => typeof row.slug === "string" && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(row.slug))
      .map(row => row.minimal_client_version)
      .filter((value): value is string => typeof value === "string");
    expect(gatedFloors.length).toBeGreaterThan(0);
    expect(gatedFloors).toContain(GATED_MODEL_CLIENT_VERSION_FLOOR);
    // Highest, so no gated model is asked for under a version that cannot return it.
    for (const floor of gatedFloors) {
      const asNumbers = (value: string) => value.split(/[.+-]/).map(Number);
      const a = asNumbers(floor);
      const b = asNumbers(GATED_MODEL_CLIENT_VERSION_FLOOR);
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const left = Number.isFinite(a[i]) ? a[i]! : 0;
        const right = Number.isFinite(b[i]) ? b[i]! : 0;
        if (left !== right) {
          expect(left).toBeLessThan(right);
          break;
        }
      }
    }
    // And it is never the placeholder that caused #2886.
    expect(GATED_MODEL_CLIENT_VERSION_FLOOR).not.toBe("0.0.0");
  });

  test("the placeholder 0.0.0 is never accepted as a client version", async () => {
    // 0.0.0 is exactly what shipped, and it is a syntactically valid version string, so the
    // guard has to reject it by value rather than by shape.
    // Rejected by value means "does not win the precedence chain": each of these falls
    // through to the derived floor rather than being asked upstream verbatim.
    // Every assertion here is about a SUPPLIED loader, so each bypasses the process memo that
    // describes the real runtime file — otherwise one case's cached read answers the next.
    const ask = (inbound: string | null, load: () => { selectedVersion?: string | null } | null) =>
      resolveCodexEntitlementClientVersion(inbound, load, { bypassRuntimeMemo: true });
    expect(ask("0.0.0", () => null))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    expect(ask("", () => null))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    expect(ask(null, () => null))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    expect(ask("0.146.0", () => null)).toBe("0.146.0");
    // The inbound value wins over the persisted runtime; the runtime is the sync fallback.
    expect(ask("0.146.0", () => ({ selectedVersion: "0.120.0" }))).toBe("0.146.0");
    expect(ask(null, () => ({ selectedVersion: "0.145.1" }))).toBe("0.145.1");
    // A persisted `0.0.0` is the same placeholder and must not be preferred over the floor.
    expect(ask(null, () => ({ selectedVersion: "0.0.0" })))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    // A persisted-state read that throws must not take entitlement down with it.
    expect(ask(null, () => { throw new Error("unreadable"); }))
      .toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    // isUsableCodexClientVersion is the by-value guard the chain relies on.
    expect(isUsableCodexClientVersion("0.0.0")).toBe(false);
    expect(isUsableCodexClientVersion("0.142.2")).toBe(true);
    // Every spelling of an all-zero core makes the same claim `0.0.0` does, so rejecting only
    // the exact string would leave the defect reachable through a variant.
    for (const zeroish of ["0", "0.0", "00.0.0", "0.0.0-dev", "0.0.0.0", " 0.0.0 "]) {
      expect(isUsableCodexClientVersion(zeroish)).toBe(false);
      expect(ask(zeroish, () => null)).toBe(GATED_MODEL_CLIENT_VERSION_FLOOR);
    }
    // Bounded, because the value is interpolated into an outbound URL.
    expect(isUsableCodexClientVersion(`0.${"9".repeat(120)}`)).toBe(false);
    // A leading-zero segment with a nonzero core is still a real version.
    expect(isUsableCodexClientVersion("00.142.2")).toBe(true);
  });

  test("the persisted runtime version is not re-read from disk on every resolution", () => {
    // Tier 2 reads codex-runtime.json, and it is consulted on every gated Direct authorization
    // and every /v1/models resolution — including when the roster cache is hot and the answer
    // needs no I/O. Without a memo that is a synchronous readFileSync on the request path.
    let reads = 0;
    const loader = () => {
      reads += 1;
      return { selectedVersion: "0.147.3" };
    };

    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 1_000 })).toBe("0.147.3");
    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 1_200 })).toBe("0.147.3");
    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 3_000 })).toBe("0.147.3");
    // Three resolutions inside the memo window, one read.
    expect(reads).toBe(1);

    // Past the window the file is consulted again, so a runtime switch is still picked up.
    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 20_000 })).toBe("0.147.3");
    expect(reads).toBe(2);

    // An inbound version short-circuits before tier 2, so no read happens at all.
    expect(resolveCodexEntitlementClientVersion("0.150.0", loader, { now: 40_000 })).toBe("0.150.0");
    expect(reads).toBe(2);

    // The bypass is what lets a caller ask about a loader other than the real runtime file.
    expect(resolveCodexEntitlementClientVersion(null, () => ({ selectedVersion: "0.149.9" }), {
      bypassRuntimeMemo: true,
    })).toBe("0.149.9");
  });

  test("a cached roster is projected only for the version it was fetched under", async () => {
    // Upstream's answer is version-specific, so reusing it across versions would either hide
    // models from a newer client or advertise them to an older one (#2548, inverted). The
    // cache holds one entry per account, so what matters is that the entry knows its own
    // version and the projection respects it.
    seedCodexModelEntitlementsForTests("main", [SOL, TERRA, LUNA], 1_000, "0.146.0");

    expect([...cachedAvailableAccountGatedNativeModels(1_100, undefined, "0.146.0")])
      .toEqual([SOL, TERRA, LUNA]);
    // A caller asking about an older client must not be handed the newer client's roster.
    expect([...cachedAvailableAccountGatedNativeModels(1_100, undefined, "0.140.0")]).toEqual([]);
    // An unusable version cannot select an entry at all, so it degrades to the unfiltered
    // read rather than silently matching one.
    expect([...cachedAvailableAccountGatedNativeModels(1_100, undefined, "0.0.0")])
      .toEqual([SOL, TERRA, LUNA]);
  });

  // The projection test above seeds the cache directly, so it cannot see the cache-hit key or
  // the in-flight key — both survived being reverted while it stayed green. These two drive
  // the real write path instead. A Direct caller's credential identity is derived from its own
  // bearer token (`direct:<hash>`), so it satisfies the identity guard that decides whether a
  // completed flight is allowed to write, which a synthetic pool credential never does.
  function directHeaders(token: string): Headers {
    return new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": "acct-1" });
  }

  test("a roster fetched under one version is refetched for another, not reused", async () => {
    const asked: string[] = [];
    const backend = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      asked.push(url.searchParams.get("client_version") ?? "");
      return roster(SOL);
    }) as typeof fetch;

    // Same account, same credential, same instant — only the version differs.
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-refetch"), SOL, {
      fetcher: backend, now: 1_000, clientVersion: "0.146.0",
    })).toBe(true);
    // Second ask under the SAME version is served from cache: no new request.
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-refetch"), SOL, {
      fetcher: backend, now: 1_000, clientVersion: "0.146.0",
    })).toBe(true);
    expect(asked).toEqual(["0.146.0"]);

    // A different version is a different question and must reach upstream again, even though
    // the entry is still well within its TTL.
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-refetch"), SOL, {
      fetcher: backend, now: 1_000, clientVersion: "0.150.0",
    })).toBe(true);
    expect(asked).toEqual(["0.146.0", "0.150.0"]);
  });

  test("two versions in flight for one account do not overwrite each other's evidence", async () => {
    // The failure this pins: with an account-only cache key, the LATER-completing version
    // overwrites the earlier one, and the unversioned projection readers in catalog/metadata
    // then publish whichever landed last rather than what each client actually proved.
    const release: Array<() => void> = [];
    const backend = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const version = url.searchParams.get("client_version") ?? "";
      // The newer client is entitled; the older one is not.
      const body = version === "0.150.0" ? roster(SOL, TERRA) : roster("gpt-5.5");
      await new Promise<void>(resolve => release.push(resolve));
      return body;
    }) as typeof fetch;

    const newer = isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: backend, now: 1_000, clientVersion: "0.150.0",
    });
    const older = isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: backend, now: 1_000, clientVersion: "0.140.0",
    });
    // Let both requests reach the backend, then complete the NEWER one first so the older,
    // model-less roster is the last write.
    while (release.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    release[0]!();
    release[1]!();

    expect(await newer).toBe(true);
    expect(await older).toBe(false);

    // Each version's evidence survives independently: the late, empty roster did not erase
    // the newer client's confirmation.
    expect([...cachedAvailableAccountGatedNativeModels(1_100, undefined, "0.150.0")]).toEqual([]);
    // Direct entries are excluded from the CATALOG projection by design, so assert through the
    // entitlement check itself — both answers must still be served from cache, unchanged.
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: (async () => { throw new Error("must be served from cache"); }) as typeof fetch,
      now: 1_000,
      clientVersion: "0.150.0",
    })).toBe(true);
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: (async () => { throw new Error("must be served from cache"); }) as typeof fetch,
      now: 1_000,
      clientVersion: "0.140.0",
    })).toBe(false);
  });
});
