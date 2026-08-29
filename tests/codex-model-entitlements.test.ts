import { beforeEach, describe, expect, test } from "bun:test";
import {
  availableAccountGatedNativeModels,
  cachedAvailableAccountGatedNativeModels,
  entitledCodexAccountIdsForModel,
  isDirectCallerEntitledToCodexModel,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexEntitlementClientVersion,
  resolveCodexModelEntitlements,
  seedCodexModelEntitlementsForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../src/codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";

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

  test("no trustworthy version means UNCONFIRMED, not a confirmed denial", async () => {
    // Fail closed on absent evidence is the existing contract; failing closed on invented
    // evidence is the defect. A placeholder would return a real 200 with a short roster,
    // which reads as "this account positively lacks these models".
    //
    // `clientVersion: null` is an inbound miss, not a verdict — the resolver still consults
    // the selected runtime, which is the whole point of the precedence chain. To reach the
    // no-evidence branch both sources have to be unusable, so this pins the resolver's own
    // output and then drives discovery with it.
    expect(resolveCodexEntitlementClientVersion(null, () => null)).toBeNull();
    const seen: string[] = [];
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: versionFilteredBackend(seen),
      now: 1_000,
      clientVersion: null,
      // Both halves of the chain unusable: no inbound version, no selected runtime.
      loadPersistedRuntime: () => null,
    });

    expect(seen).toEqual([]);
    expect(snapshot.confirmedAccountIds.has("main")).toBe(false);
    // Read the SNAPSHOT, not the process-wide cache: another suite in the same run can leave
    // a confirmed entry behind, and this assertion is about what this discovery pass proved.
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([]);
    expect(snapshot.modelsByAccount.get("main")?.size).toBe(0);
    // The account is still enumerated, so callers can tell "unknown" from "absent".
    expect(snapshot.modelsByAccount.has("main")).toBe(true);
  });

  test("the placeholder 0.0.0 is never accepted as a client version", async () => {
    // 0.0.0 is exactly what shipped, and it is a syntactically valid version string, so the
    // guard has to reject it by value rather than by shape.
    expect(resolveCodexEntitlementClientVersion("0.0.0", () => null)).toBeNull();
    expect(resolveCodexEntitlementClientVersion("", () => null)).toBeNull();
    expect(resolveCodexEntitlementClientVersion(null, () => null)).toBeNull();
    expect(resolveCodexEntitlementClientVersion("0.146.0", () => null)).toBe("0.146.0");
    // The inbound value wins over the persisted runtime; the runtime is the sync fallback.
    expect(resolveCodexEntitlementClientVersion("0.146.0", () => ({ selectedVersion: "0.120.0" })))
      .toBe("0.146.0");
    expect(resolveCodexEntitlementClientVersion(null, () => ({ selectedVersion: "0.145.1" })))
      .toBe("0.145.1");
    expect(resolveCodexEntitlementClientVersion(null, () => ({ selectedVersion: "0.0.0" }))).toBeNull();
    // A persisted-state read that throws must not take entitlement down with it.
    expect(resolveCodexEntitlementClientVersion(null, () => { throw new Error("unreadable"); })).toBeNull();
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
});
