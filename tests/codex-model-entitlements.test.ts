import { beforeEach, describe, expect, test } from "bun:test";
import {
  availableAccountGatedNativeModels,
  cachedAvailableAccountGatedNativeModels,
  deriveGatedClientVersionFloor,
  entitledCodexAccountIdsForModel,
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  isDirectCallerEntitledToCodexModel,
  isUsableCodexClientVersion,
  memoizeRuntimeVersionForTests,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexEntitlementClientVersion,
  resolveCodexModelEntitlements,
  seedCodexModelEntitlementsForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../src/codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { clearCodexRuntimeResolveCache, loadPersistedCodexRuntime } from "../src/codex/runtime";
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

  test("the gated floor derivation picks the highest usable gated version", () => {
    // Asserted on INDEPENDENT fixtures, not the shipped snapshot. An earlier version of this test
    // compared the constant against the bundled data and reimplemented the comparator, so it
    // stayed green even if the whole derivation were replaced by the literal the fixture happens
    // to contain — vacuous in exactly the way that matters.
    const gated = new Set(["a", "b", "c"]);
    const derive = (rows: Array<Record<string, unknown>>) => deriveGatedClientVersionFloor(rows, gated);

    // Highest wins, and ordering in the input does not matter.
    expect(derive([
      { slug: "a", minimal_client_version: "0.98.0" },
      { slug: "b", minimal_client_version: "0.142.2" },
      { slug: "c", minimal_client_version: "0.124.0" },
    ])).toBe("0.142.2");
    expect(derive([
      { slug: "b", minimal_client_version: "0.142.2" },
      { slug: "a", minimal_client_version: "0.98.0" },
    ])).toBe("0.142.2");
    // Numeric comparison, not lexicographic: "0.98.0" must not beat "0.142.2".
    expect(derive([
      { slug: "a", minimal_client_version: "0.9.0" },
      { slug: "b", minimal_client_version: "0.10.0" },
    ])).toBe("0.10.0");

    // Non-gated rows are ignored even when they record a higher floor.
    expect(derive([
      { slug: "a", minimal_client_version: "0.100.0" },
      { slug: "unrelated", minimal_client_version: "9.9.9" },
    ])).toBe("0.100.0");

    // Unusable and missing values are skipped rather than selected.
    expect(derive([
      { slug: "a", minimal_client_version: "0.0.0" },
      { slug: "b", minimal_client_version: "" },
      { slug: "c", minimal_client_version: "0.130.0" },
    ])).toBe("0.130.0");
    expect(derive([{ slug: "a" }, { slug: "b", minimal_client_version: 5 }])).toBeNull();
    expect(derive([])).toBeNull();

    // And the shipped constant is a real, filterable version — never the #2886 placeholder.
    expect(isUsableCodexClientVersion(GATED_MODEL_CLIENT_VERSION_FLOOR)).toBe(true);
    expect(GATED_MODEL_CLIENT_VERSION_FLOOR).not.toBe("0.0.0");
  });

  test("concurrent roster requests for one account are bounded", async () => {
    // Distinct client_version values miss the flight key by design, so without a bound a caller
    // cycling versions could open arbitrarily many concurrent upstream requests, each holding an
    // 8s timer. Over the bound the answer is unconfirmed — the same fail-closed result a discovery
    // failure gives.
    let opened = 0;
    const gate: Array<() => void> = [];
    const backend = (async () => {
      opened += 1;
      await new Promise<void>(resolve => gate.push(resolve));
      return roster(SOL);
    }) as typeof fetch;

    const asks = Array.from({ length: 12 }, (_, i) => isDirectCallerEntitledToCodexModel(
      directHeaders("tok-flights"),
      SOL,
      { fetcher: backend, now: 1_000, clientVersion: `0.${400 + i}.0` },
    ));

    // Give the admitted flights a turn to reach the backend, then release them.
    while (gate.length < 4) await new Promise(resolve => setTimeout(resolve, 0));
    for (const release of gate) release();
    const results = await Promise.all(asks);

    // At most the bound reached upstream; the rest were refused without a request.
    expect(opened).toBeLessThanOrEqual(4);
    // The refused ones are unconfirmed, not confirmed-denied by a bad roster.
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(4);
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
    // A SUPPLIED loader is auto-bypassed — the memo describes the real runtime file, so answering
    // a different loader from it would cross-answer. Each call must therefore read.
    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 1_000 })).toBe("0.147.3");
    expect(resolveCodexEntitlementClientVersion(null, loader, { now: 1_100 })).toBe("0.147.3");
    expect(reads).toBe(2);

    // The memo applies to the DEFAULT loader, which is the one on the request path. Count reads
    // of the real state file through the seam runtime.ts exposes for it.
    let defaultReads = 0;
    const countingDefault = () => {
      defaultReads += 1;
      return loadPersistedCodexRuntime();
    };
    // Establish the memo, then assert three further resolutions inside the window are free.
    memoizeRuntimeVersionForTests(countingDefault, 1_000);
    expect(defaultReads).toBe(1);
    memoizeRuntimeVersionForTests(countingDefault, 1_200);
    memoizeRuntimeVersionForTests(countingDefault, 3_000);
    expect(defaultReads).toBe(1);

    // Past the window the file is consulted again, so a runtime switch is still picked up.
    memoizeRuntimeVersionForTests(countingDefault, 20_000);
    expect(defaultReads).toBe(2);

    // An inbound version short-circuits before tier 2, so no read happens at all.
    expect(resolveCodexEntitlementClientVersion("0.150.0", loader, { now: 40_000 })).toBe("0.150.0");
    expect(reads).toBe(2);
  });

  test("persisting a new runtime invalidates the memoized version immediately", () => {
    // A five-second staleness window is not merely a late answer: background sync can commit the
    // wrong roster to disk inside it. A newer->older switch would confirm models the older client
    // cannot drive; older->newer would deny models the account owns. The memo is therefore fenced
    // on the runtime module's own epoch, which persistCodexRuntime bumps as it writes.
    let version = "0.147.3";
    let reads = 0;
    const loader = () => {
      reads += 1;
      return { selectedVersion: version };
    };

    expect(memoizeRuntimeVersionForTests(loader, 1_000)).toBe("0.147.3");
    expect(reads).toBe(1);
    // Same epoch, inside the window: memoized.
    expect(memoizeRuntimeVersionForTests(loader, 1_100)).toBe("0.147.3");
    expect(reads).toBe(1);

    // The runtime is replaced. Even well inside the time window, the next read must see it.
    version = "0.120.0";
    clearCodexRuntimeResolveCache();
    expect(memoizeRuntimeVersionForTests(loader, 1_200)).toBe("0.120.0");
    expect(reads).toBe(2);
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
    // entitlement check itself. A THROWING fetcher would be useless for the negative case:
    // production converts a failed fetch into an unconfirmed roster, which is also `false`, so it
    // could not tell a cache hit from a refetch. Count requests, and have any refetch return the
    // OPPOSITE answer, so serving from cache is the only way each assertion can hold.
    let refetches = 0;
    const inverted = (async (input: RequestInfo | URL) => {
      refetches += 1;
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Inverted on purpose: 0.150.0 would become denied, 0.140.0 would become entitled.
      return url.searchParams.get("client_version") === "0.150.0" ? roster("gpt-5.5") : roster(SOL);
    }) as typeof fetch;

    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: inverted, now: 1_000, clientVersion: "0.150.0",
    })).toBe(true);
    expect(await isDirectCallerEntitledToCodexModel(directHeaders("tok-race"), SOL, {
      fetcher: inverted, now: 1_000, clientVersion: "0.140.0",
    })).toBe(false);
    expect(refetches).toBe(0);
  });

  test("one caller cycling client_version cannot evict another account's evidence", async () => {
    // `client_version` arrives on the inbound request, so making it part of the cache key handed
    // callers a knob on key cardinality. With a flat per-key budget, ONE caller cycling versions
    // filled its whole eviction class and pushed unrelated accounts' confirmed grants out — the
    // fail-closed catalog flapping the two-class budget exists to prevent, reached by a new axis.
    //
    // Asserted through the Direct path on purpose: a synthetic pool credential never satisfies
    // `currentCredentialIdentity`, so a resolver call with one writes NOTHING to the cache and an
    // eviction test built on it passes without ever storing an entry. (That mistake was made and
    // caught here: the first version of this test was vacuous for exactly that reason.)
    let fetches = 0;
    const backend = (async () => { fetches += 1; return roster(SOL); }) as typeof fetch;
    const ask = (token: string, version: string) => isDirectCallerEntitledToCodexModel(
      directHeaders(token),
      SOL,
      { fetcher: backend, now: 1_000, clientVersion: version },
    );

    // The victim's entry is genuinely cached: a second identical ask does not refetch.
    expect(await ask("tok-victim", "0.146.0")).toBe(true);
    const afterVictim = fetches;
    expect(await ask("tok-victim", "0.146.0")).toBe(true);
    expect(fetches).toBe(afterVictim);

    // One noisy caller, far more distinct versions than the per-class account budget.
    for (let i = 0; i < 90; i += 1) await ask("tok-noisy", `0.${150 + i}.0`);

    // The victim is still inside its TTL, so this must be a cache hit, not a refetch.
    const beforeRecheck = fetches;
    expect(await ask("tok-victim", "0.146.0")).toBe(true);
    expect(fetches).toBe(beforeRecheck);
  });

  test("a single account retains only a bounded number of versions", async () => {
    // The per-account bound is what makes the class budget safe. Without it, one account's
    // versions grow without limit inside its own class.
    let fetches = 0;
    const backend = (async () => { fetches += 1; return roster(SOL); }) as typeof fetch;
    const ask = (version: string) => isDirectCallerEntitledToCodexModel(
      directHeaders("tok-bounded"),
      SOL,
      { fetcher: backend, now: 1_000, clientVersion: version },
    );

    for (let i = 0; i < 10; i += 1) await ask(`0.${200 + i}.0`);
    expect(fetches).toBe(10);

    // The most recent version is still cached.
    const afterFill = fetches;
    expect(await ask("0.209.0")).toBe(true);
    expect(fetches).toBe(afterFill);

    // The oldest has been dropped, so it costs a refetch rather than living forever.
    expect(await ask("0.200.0")).toBe(true);
    expect(fetches).toBe(afterFill + 1);
  });

  test("the class budget counts accounts, not cached keys", async () => {
    // The documented budget is 64 ACCOUNTS per class. Counting keys instead would silently divide
    // that by the per-account version bound, so a deployment well inside the intended limit would
    // start losing evidence: 20 accounts holding 4 versions each is 80 keys but only 20 accounts.
    let fetches = 0;
    const backend = (async () => { fetches += 1; return roster(SOL); }) as typeof fetch;
    const ask = (token: string, version: string) => isDirectCallerEntitledToCodexModel(
      directHeaders(token),
      SOL,
      { fetcher: backend, now: 1_000, clientVersion: version },
    );

    expect(await ask("tok-first", "0.146.0")).toBe(true);

    // Twenty further accounts, each using the full per-account version allowance.
    for (let account = 0; account < 20; account += 1) {
      for (let v = 0; v < 4; v += 1) await ask(`tok-${account}`, `0.${300 + v}.0`);
    }

    // Far more than 64 keys are now live, but far fewer than 64 accounts, so the first account's
    // entry must still be served from cache.
    const before = fetches;
    expect(await ask("tok-first", "0.146.0")).toBe(true);
    expect(fetches).toBe(before);
  });
});
