import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS,
  availableAccountGatedNativeModels,
  cachedAvailableAccountGatedNativeModels,
  codexModelEntitlementStateForAccount,
  composeGatedClientVersionFloorForTests,
  compareClientVersionsForTests,
  codexEntitlementNegativeMemoForTests,
  deriveGatedClientVersionFloor,
  ensureCodexEntitlementFreshness,
  entitledCodexAccountIdsForModel,
  GATED_MODEL_CLIENT_VERSION_FLOOR,
  getCodexModelEntitlementStatus,
  isDirectCallerEntitledToCodexModel,
  isUsableCodexClientVersion,
  memoizeRuntimeVersionForTests,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexEntitlementClientVersion,
  resolveCodexModelEntitlements,
  seedCodexModelEntitlementsForTests,
  type CodexModelEntitlementCredentialSnapshot,
  type CodexModelEntitlementState,
} from "../src/codex/model-entitlements";
import {
  forceRefreshMainAccountToken,
  MAIN_CODEX_ACCOUNT_ID,
} from "../src/codex/main-account";
import {
  readCodexAccountRecord,
  saveCodexAccountCredential,
} from "../src/codex/account-store";
import { clearCodexRuntimeResolveCache, loadPersistedCodexRuntime } from "../src/codex/runtime";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import upstreamModelsSnapshot from "../src/codex/data/upstream-models.json";
import { readCodexAccountRecord, saveCodexAccountCredential } from "../src/codex/account-store";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

function projectedEntitlementState(
  snapshot: Awaited<ReturnType<typeof resolveCodexModelEntitlements>>,
  accountId: string,
  modelId: string,
): CodexModelEntitlementState {
  return codexModelEntitlementStateForAccount(snapshot, accountId, modelId);
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

describe("Codex account model entitlements", () => {
  test("keeps parsed-empty distinct from refresh failures end to end", async () => {
    const isolated = installIsolatedCodexHome("ocx-entitlement-provenance-");
    const accountId = "pool-provenance";
    const config = {
      codexAccounts: [{ id: accountId, email: "pool-provenance@example.test", isMain: false }],
    };
    try {
      saveCodexAccountCredential(accountId, {
        accessToken: "provenance-access",
        refreshToken: "provenance-refresh",
        expiresAt: Date.now() + 60_000,
        chatgptAccountId: "chatgpt-provenance",
      });
      const generation = readCodexAccountRecord(accountId)!.generation;
      const storedCredential: CodexModelEntitlementCredentialSnapshot = {
        accountId,
        accessToken: "provenance-access",
        chatgptAccountId: "chatgpt-provenance",
        credentialIdentity: `pool:${generation}:chatgpt-provenance`,
      };
      const cases: Array<{
        name: string;
        fetcher: typeof fetch;
        expected: Record<string, unknown>;
      }> = [
        {
          name: "parsed-empty",
          fetcher: (async () => Response.json({ models: [] })) as typeof fetch,
          expected: { status: "unconfirmed-empty" },
        },
        {
          name: "http-error",
          fetcher: (async () => new Response("upstream failed", { status: 503 })) as typeof fetch,
          expected: { status: "failed", reason: "http-error", httpStatus: 503 },
        },
        {
          name: "network-error",
          fetcher: (async () => { throw new TypeError("connection refused"); }) as typeof fetch,
          expected: { status: "failed", reason: "network-error" },
        },
        {
          name: "timeout",
          fetcher: (async () => { throw new DOMException("timed out", "TimeoutError"); }) as typeof fetch,
          expected: { status: "failed", reason: "timeout" },
        },
        {
          name: "unparseable",
          fetcher: (async () => new Response("not-json")) as typeof fetch,
          expected: { status: "failed", reason: "unparseable" },
        },
      ];

      for (const testCase of cases) {
        resetCodexModelEntitlementCacheForTests();
        await resolveCodexModelEntitlements(config, {
          credentials: [storedCredential],
          fetcher: testCase.fetcher,
          now: 1_000,
          clientVersion: TEST_CLIENT_VERSION,
        });
        expect(
          getCodexModelEntitlementStatus(config, 1_001, TEST_CLIENT_VERSION),
          testCase.name,
        ).toEqual(testCase.expected);
      }
    } finally {
      isolated.restore();
    }
  });

  test("default entitlement status uses the same client-version cache key as resolution", async () => {
    const isolated = installIsolatedCodexHome("ocx-entitlement-default-version-");
    const accountId = "pool-default-version";
    const config = {
      codexAccounts: [{ id: accountId, email: "pool-default-version@example.test", isMain: false }],
    };
    try {
      saveCodexAccountCredential(accountId, {
        accessToken: "default-version-access",
        refreshToken: "default-version-refresh",
        expiresAt: Date.now() + 60_000,
        chatgptAccountId: "chatgpt-default-version",
      });
      const generation = readCodexAccountRecord(accountId)!.generation;
      await resolveCodexModelEntitlements(config, {
        credentials: [{
          accountId,
          accessToken: "default-version-access",
          chatgptAccountId: "chatgpt-default-version",
          credentialIdentity: `pool:${generation}:chatgpt-default-version`,
        }],
        fetcher: (async () => roster(SOL)) as typeof fetch,
        now: 1_000,
      });

      expect(getCodexModelEntitlementStatus(config, 1_001)).toEqual({ status: "fresh" });
    } finally {
      isolated.restore();
    }
  });

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

  test("ignores hidden or API-disabled rows, and does not call the result a confirmation", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => Response.json({ models: [
        { slug: DAYBREAK, supported_in_api: true, visibility: "hide" },
        { slug: "gpt-disabled", supported_in_api: false, visibility: "list" },
      ] })) as typeof fetch,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
    });

    // INTENTIONAL ASSERTION FLIP (#3022). This used to assert `true`: rows arrived, so the
    // parse "succeeded". But every row was filtered out, so the account proved nothing, and
    // calling that a confirmation locked an empty roster in for the five-minute success TTL.
    // Confirmation means usable evidence, not a successful HTTP round trip.
    expect(snapshot.confirmedAccountIds.has("main")).toBe(false);
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

describe("tri-state entitlement authority", () => {
  const directHeaders = (): Headers => new Headers({
    authorization: "Bearer tri-state-caller",
    "chatgpt-account-id": "tri-state-account",
  });

  test("an omitted gated slug below its minimum is unknown and uses the failure TTL", async () => {
    let fetches = 0;
    const backend = (async () => {
      fetches += 1;
      return roster("gpt-5.5");
    }) as typeof fetch;

    expect(await isDirectCallerEntitledToCodexModel(directHeaders(), SOL, {
      fetcher: backend,
      now: 1_000,
      clientVersion: "0.140.0",
    })).toBe(false);
    expect(await isDirectCallerEntitledToCodexModel(directHeaders(), SOL, {
      fetcher: backend,
      now: 15_999,
      clientVersion: "0.140.0",
    })).toBe(false);
    expect(fetches).toBe(1);
    expect(await isDirectCallerEntitledToCodexModel(directHeaders(), SOL, {
      fetcher: backend,
      now: 16_001,
      clientVersion: "0.140.0",
    })).toBe(false);
    expect(fetches).toBe(2);

    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => roster("gpt-5.5")) as typeof fetch,
      now: 20_000,
      clientVersion: "0.140.0",
    });
    expect(snapshot.clientVersionByAccount.get("main")).toBe("0.140.0");
    expect(projectedEntitlementState(snapshot, "main", SOL)).toBe("unknown");
    expect(entitledCodexAccountIdsForModel(snapshot, SOL)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).has(SOL)).toBe(false);
  });

  test("an omitted gated slug at its minimum is denied", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => roster("gpt-5.5")) as typeof fetch,
      now: 1_000,
      clientVersion: "0.144.0",
    });

    expect(projectedEntitlementState(snapshot, "main", SOL)).toBe("denied");
    expect(entitledCodexAccountIdsForModel(snapshot, SOL)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).has(SOL)).toBe(false);
  });

  test("a present gated slug below its minimum is granted", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => roster("gpt-5.5", SOL)) as typeof fetch,
      now: 1_000,
      clientVersion: "0.140.0",
    });

    expect(projectedEntitlementState(snapshot, "main", SOL)).toBe("granted");
    expect([...entitledCodexAccountIdsForModel(snapshot, SOL)!]).toEqual(["main"]);
    expect(availableAccountGatedNativeModels(snapshot).has(SOL)).toBe(true);
  });

  test("Daybreak omission remains denied without a known minimum", async () => {
    expect(ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS.get(SOL)).toBe("0.144.0");
    expect(ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS.has(DAYBREAK)).toBe(false);

    for (const clientVersion of ["0.140.0", "0.200.0"]) {
      const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
        credentials: [credential(`main-${clientVersion}`)],
        fetcher: (async () => roster("gpt-5.5")) as typeof fetch,
        now: 1_000,
        clientVersion,
      });
      expect(projectedEntitlementState(snapshot, `main-${clientVersion}`, DAYBREAK)).toBe("denied");
      expect(entitledCodexAccountIdsForModel(snapshot, DAYBREAK)?.size).toBe(0);
      expect(availableAccountGatedNativeModels(snapshot).has(DAYBREAK)).toBe(false);
    }
  });

  test("CHARACTERIZATION: no positive projection returns a gated slug absent from the roster", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => roster("gpt-5.5")) as typeof fetch,
      now: 1_000,
      clientVersion: "0.140.0",
    });
    expect(entitledCodexAccountIdsForModel(snapshot, SOL)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).has(SOL)).toBe(false);

    seedCodexModelEntitlementsForTests("main", ["gpt-5.5"], 1_000, "0.140.0");
    expect(cachedAvailableAccountGatedNativeModels(1_001, undefined, "0.140.0").has(SOL))
      .toBe(false);
    expect(await isDirectCallerEntitledToCodexModel(directHeaders(), SOL, {
      fetcher: (async () => roster("gpt-5.5")) as typeof fetch,
      now: 1_000,
      clientVersion: "0.140.0",
    })).toBe(false);
  });

  test("CHARACTERIZATION: an unconfirmed roster cannot grant a present gated slug", () => {
    const snapshot = {
      modelsByAccount: new Map([["main", new Set([SOL])]]),
      clientVersionByAccount: new Map([["main", "0.140.0"]]),
      confirmedAccountIds: new Set<string>(),
      credentialIdentities: new Map([["main", "test:main"]]),
    };

    expect(projectedEntitlementState(snapshot, "main", SOL)).toBe("unknown");
    expect(entitledCodexAccountIdsForModel(snapshot, SOL)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).has(SOL)).toBe(false);
  });
});

describe("ensureCodexEntitlementFreshness", () => {
  const originalOpenCodexHome = process.env.OPENCODEX_HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  let root = "";
  let codexHome = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-entitlement-freshness-"));
    codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.OPENCODEX_HOME = join(root, "opencodex");
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalOpenCodexHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    removeTreeWithRetry(root);
    resetCodexModelEntitlementCacheForTests();
  });

  const poolConfig = (...ids: string[]) => ({
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
  });

  const savePoolCredential = (accountId: string, suffix: string): void => {
    saveCodexAccountCredential(accountId, {
      accessToken: `access-${suffix}`,
      refreshToken: `refresh-${suffix}`,
      expiresAt: Date.now() + 60 * 60_000,
      chatgptAccountId: `chatgpt-${suffix}`,
    });
  };

  const storedCredentialSnapshot = async (
    accountId: string,
  ): Promise<CodexModelEntitlementCredentialSnapshot | null> => {
    if (accountId === MAIN_CODEX_ACCOUNT_ID) return null;
    const record = readCodexAccountRecord(accountId);
    if (!record?.credential || record.deletedAt != null) return null;
    return {
      accountId,
      accessToken: record.credential.accessToken,
      chatgptAccountId: record.credential.chatgptAccountId,
      credentialIdentity: `pool:${record.generation}:${record.credential.chatgptAccountId}`,
    };
  };

  const writeMainAuth = (suffix: string): void => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: `access-${suffix}`,
        account_id: `chatgpt-${suffix}`,
      },
    }));
  };

  const mainCredentialSnapshot = async (
    accountId: string,
  ): Promise<CodexModelEntitlementCredentialSnapshot | null> => {
    if (accountId !== MAIN_CODEX_ACCOUNT_ID) return null;
    const parsed = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as {
      tokens: { access_token: string; account_id: string };
    };
    return {
      accountId,
      accessToken: parsed.tokens.access_token,
      chatgptAccountId: parsed.tokens.account_id,
      credentialIdentity: `main:${parsed.tokens.account_id}`,
    };
  };

  test("reports an expired roster during outer-flight credential acquisition", async () => {
    const accountId = "pool-outer-flight";
    const config = poolConfig(accountId);
    savePoolCredential(accountId, "outer-flight");
    const baseOptions = {
      clientVersion: TEST_CLIENT_VERSION,
      fetcher: (async () => roster(SOL)) as typeof fetch,
    };
    await ensureCodexEntitlementFreshness(config, {
      ...baseOptions,
      waitMs: 1_000,
      now: 1_000,
      credentialSnapshot: storedCredentialSnapshot,
    });

    const credentialReadStarted = deferred();
    const releaseCredentialRead = deferred();
    const blockedCredentialSnapshot = async (
      candidateAccountId: string,
    ): Promise<CodexModelEntitlementCredentialSnapshot | null> => {
      if (candidateAccountId !== accountId) return null;
      credentialReadStarted.resolve();
      await releaseCredentialRead.promise;
      return storedCredentialSnapshot(candidateAccountId);
    };
    const refreshOptions = {
      ...baseOptions,
      waitMs: 0,
      now: 301_001,
      credentialSnapshot: blockedCredentialSnapshot,
    };
    try {
      await ensureCodexEntitlementFreshness(config, refreshOptions);
      await credentialReadStarted.promise;
      expect(getCodexModelEntitlementStatus(config, 301_001, TEST_CLIENT_VERSION))
        .toEqual({ status: "expired-refresh-in-flight" });
    } finally {
      releaseCredentialRead.resolve();
      await ensureCodexEntitlementFreshness(config, { ...refreshOptions, waitMs: 1_000 });
    }
  });

  test("a fresh ensure uses identity reads but performs zero full credential snapshots or network calls", async () => {
    savePoolCredential("pool-fresh", "fresh");
    let credentialReads = 0;
    let fetches = 0;
    const options = {
      waitMs: 1_000,
      now: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: async (accountId: string) => {
        credentialReads += 1;
        return storedCredentialSnapshot(accountId);
      },
      fetcher: (async () => { fetches += 1; return roster(SOL, TERRA, LUNA); }) as typeof fetch,
    };

    await ensureCodexEntitlementFreshness(poolConfig("pool-fresh"), options);
    expect(credentialReads).toBe(2);
    expect(fetches).toBe(1);

    credentialReads = 0;
    await ensureCodexEntitlementFreshness(poolConfig("pool-fresh"), { ...options, now: 1_001 });
    expect(credentialReads).toBe(0);
    expect(fetches).toBe(1);
  });

  test("logged-out polls memoize the missing credential for exactly the bounded window", async () => {
    let credentialReads = 0;
    const options = {
      waitMs: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: async () => { credentialReads += 1; return null; },
    };

    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, now: 10_000 });
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, now: 14_999 });
    expect(credentialReads).toBe(1);

    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, now: 15_001 });
    expect(credentialReads).toBe(2);
  });

  test("a credential commit invalidates a negative memo before the next ensure", async () => {
    let poolReads = 0;
    let fetches = 0;
    const snapshot = async (accountId: string) => {
      if (accountId === "pool-login") poolReads += 1;
      return storedCredentialSnapshot(accountId);
    };
    const options = {
      waitMs: 1_000,
      now: 20_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: snapshot,
      fetcher: (async () => { fetches += 1; return roster(SOL); }) as typeof fetch,
    };

    await ensureCodexEntitlementFreshness(poolConfig("pool-login"), options);
    expect(poolReads).toBe(1);
    expect(fetches).toBe(0);

    savePoolCredential("pool-login", "new-login");
    await ensureCodexEntitlementFreshness(poolConfig("pool-login"), options);
    expect(poolReads).toBe(2);
    expect(fetches).toBe(1);
  });

  test("a same-identity main-token write invalidates a failed credential memo by epoch", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "access-memo-same",
        refresh_token: "refresh-memo-same",
        account_id: "chatgpt-memo-same",
      },
    }));
    let credentialReads = 0;
    let fetches = 0;
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, {
      waitMs: 1_000,
      now: 25_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: async () => { credentialReads += 1; return null; },
    });
    expect(credentialReads).toBe(1);

    await forceRefreshMainAccountToken("access-memo-same", {
      refreshToken: async () => ({
        access: "access-memo-same-new",
        refresh: "refresh-memo-same-new",
        expires: Date.now() + 60 * 60_000,
        accountId: "chatgpt-memo-same",
      }),
    });
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, {
      waitMs: 1_000,
      now: 25_001,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: async accountId => {
        credentialReads += 1;
        return mainCredentialSnapshot(accountId);
      },
      fetcher: (async () => { fetches += 1; return roster(SOL); }) as typeof fetch,
    });
    expect(credentialReads).toBe(2);
    expect(fetches).toBe(1);
  });

  test("a local write after absence observation fences stale negative-memo publication by epoch", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "access-publication-local",
        refresh_token: "refresh-publication-local",
        account_id: "chatgpt-publication-local",
      },
    }));
    savePoolCredential("pool-publication-local-blocker", "publication-local-blocker");
    const siblingFetchStarted = deferred();
    const releaseSiblingFetch = deferred();
    const initial = ensureCodexEntitlementFreshness(
      poolConfig("pool-publication-local-blocker"),
      {
        waitMs: 60_000,
        now: 26_000,
        clientVersion: TEST_CLIENT_VERSION,
        credentialSnapshot: async accountId => accountId === MAIN_CODEX_ACCOUNT_ID
          ? null
          : storedCredentialSnapshot(accountId),
        fetcher: (async () => {
          siblingFetchStarted.resolve();
          await releaseSiblingFetch.promise;
          return roster(SOL);
        }) as typeof fetch,
      },
    );

    await siblingFetchStarted.promise;
    await forceRefreshMainAccountToken("access-publication-local", {
      refreshToken: async () => ({
        access: "access-publication-local-new",
        refresh: "refresh-publication-local-new",
        expires: Date.now() + 60 * 60_000,
        accountId: "chatgpt-publication-local",
      }),
    });
    releaseSiblingFetch.resolve();
    await initial;

    expect(codexEntitlementNegativeMemoForTests(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
  });

  test("an external replacement after absence observation fences stale negative-memo publication by identity", async () => {
    writeMainAuth("publication-external-old");
    savePoolCredential("pool-publication-external-blocker", "publication-external-blocker");
    const siblingFetchStarted = deferred();
    const releaseSiblingFetch = deferred();
    const initial = ensureCodexEntitlementFreshness(
      poolConfig("pool-publication-external-blocker"),
      {
        waitMs: 60_000,
        now: 27_000,
        clientVersion: TEST_CLIENT_VERSION,
        credentialSnapshot: async accountId => accountId === MAIN_CODEX_ACCOUNT_ID
          ? null
          : storedCredentialSnapshot(accountId),
        fetcher: (async () => {
          siblingFetchStarted.resolve();
          await releaseSiblingFetch.promise;
          return roster(SOL);
        }) as typeof fetch,
      },
    );

    await siblingFetchStarted.promise;
    writeMainAuth("publication-external-new");
    releaseSiblingFetch.resolve();
    await initial;

    expect(codexEntitlementNegativeMemoForTests(MAIN_CODEX_ACCOUNT_ID)).toBeNull();
  });

  test("a delayed sibling fetch preserves negative-memo expiry from the absence observation", async () => {
    savePoolCredential("pool-publication-delay-blocker", "publication-delay-blocker");
    const originalNow = Date.now;
    const siblingFetchStarted = deferred();
    const releaseSiblingFetch = deferred();
    let credentialReads = 0;
    let wallNow = 10_000;
    Date.now = () => wallNow;
    try {
      const options = {
        waitMs: 60_000,
        clientVersion: TEST_CLIENT_VERSION,
        credentialSnapshot: async (accountId: string) => {
          if (accountId === MAIN_CODEX_ACCOUNT_ID) {
            credentialReads += 1;
            return null;
          }
          return storedCredentialSnapshot(accountId);
        },
        fetcher: (async () => {
          siblingFetchStarted.resolve();
          await releaseSiblingFetch.promise;
          return roster(SOL);
        }) as typeof fetch,
      };
      const initial = ensureCodexEntitlementFreshness(
        poolConfig("pool-publication-delay-blocker"),
        options,
      );
      await siblingFetchStarted.promise;

      wallNow = 40_000;
      releaseSiblingFetch.resolve();
      await initial;

      expect(codexEntitlementNegativeMemoForTests(MAIN_CODEX_ACCOUNT_ID)?.expiresAt).toBe(15_000);
      wallNow = 40_001;
      await ensureCodexEntitlementFreshness(poolConfig("pool-publication-delay-blocker"), {
        ...options,
        waitMs: 1_000,
      });
      expect(credentialReads).toBe(2);
    } finally {
      Date.now = originalNow;
      releaseSiblingFetch.resolve();
    }
  });

  test("a local credential write during a flight cannot mask the replacement", async () => {
    savePoolCredential("pool-local-race", "old");
    const firstFetchStarted = deferred();
    const releaseFirstFetch = deferred();
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      if (fetches === 1) {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
      }
      return roster(SOL);
    }) as typeof fetch;
    const config = poolConfig("pool-local-race");
    const options = {
      waitMs: 0,
      now: 30_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: storedCredentialSnapshot,
      fetcher,
    };

    await ensureCodexEntitlementFreshness(config, options);
    await firstFetchStarted.promise;
    savePoolCredential("pool-local-race", "replacement");
    await ensureCodexEntitlementFreshness(config, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);

    releaseFirstFetch.resolve();
    await ensureCodexEntitlementFreshness(config, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);
  });

  test("a same-identity main-token write cannot join its pre-write roster flight", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "access-same-identity",
        refresh_token: "refresh-same-identity",
        account_id: "chatgpt-same-identity",
      },
    }));
    const firstFetchStarted = deferred();
    const releaseFirstFetch = deferred();
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      if (fetches === 1) {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
      }
      return roster(SOL);
    }) as typeof fetch;
    const options = {
      waitMs: 0,
      now: 35_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: mainCredentialSnapshot,
      fetcher,
    };

    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, options);
    await firstFetchStarted.promise;
    await forceRefreshMainAccountToken("access-same-identity", {
      refreshToken: async () => ({
        access: "access-same-identity-new",
        refresh: "refresh-same-identity-new",
        expires: Date.now() + 60 * 60_000,
        accountId: "chatgpt-same-identity",
      }),
    });
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);

    releaseFirstFetch.resolve();
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);
  });

  test("an external auth.json replacement during a flight starts a new identity flight", async () => {
    writeMainAuth("external-old");
    const firstFetchStarted = deferred();
    const releaseFirstFetch = deferred();
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      if (fetches === 1) {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
      }
      return roster(SOL);
    }) as typeof fetch;
    const options = {
      waitMs: 0,
      now: 40_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: mainCredentialSnapshot,
      fetcher,
    };

    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, options);
    await firstFetchStarted.promise;
    writeMainAuth("external-new");
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);

    releaseFirstFetch.resolve();
    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, { ...options, waitMs: 1_000 });
    expect(fetches).toBe(2);
  });

  test("an account expiring during an A-only flight is added to a distinct workset", async () => {
    savePoolCredential("pool-work-b", "work-b");
    const counts = new Map<string, number>();
    let holdA = false;
    const aFetchStarted = deferred();
    let bRefreshStarted = false;
    const releaseA = deferred();
    const fetcher = (async (_input, init) => {
      const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
      if (accountId === "chatgpt-work-a" && holdA) {
        aFetchStarted.resolve();
        await releaseA.promise;
      }
      if (accountId === "chatgpt-work-b" && (counts.get(accountId) ?? 0) === 2) {
        bRefreshStarted = true;
      }
      return roster(SOL);
    }) as typeof fetch;
    const baseOptions = {
      waitMs: 1_000,
      clientVersion: TEST_CLIENT_VERSION,
      credentialSnapshot: storedCredentialSnapshot,
      fetcher,
    };

    await ensureCodexEntitlementFreshness(poolConfig("pool-work-b"), {
      ...baseOptions,
      now: 1_000,
    });
    expect(counts.get("chatgpt-work-b")).toBe(1);

    savePoolCredential("pool-work-a", "work-a");
    holdA = true;
    await ensureCodexEntitlementFreshness(poolConfig("pool-work-a", "pool-work-b"), {
      ...baseOptions,
      waitMs: 0,
      now: 300_999,
    });
    await aFetchStarted.promise;

    await ensureCodexEntitlementFreshness(poolConfig("pool-work-a", "pool-work-b"), {
      ...baseOptions,
      waitMs: 0,
      now: 301_001,
    });
    for (let i = 0; i < 10 && !bRefreshStarted; i += 1) await Promise.resolve();
    expect(bRefreshStarted).toBe(true);
    expect(counts.get("chatgpt-work-b")).toBe(2);

    releaseA.resolve();
    await ensureCodexEntitlementFreshness(poolConfig("pool-work-a", "pool-work-b"), {
      ...baseOptions,
      now: 301_001,
    });
    expect(counts.get("chatgpt-work-a")).toBe(1);
    expect(counts.get("chatgpt-work-b")).toBe(2);
  });

  test("a late waiter spends only the flight's remaining management wait budget", async () => {
    savePoolCredential("pool-wait", "wait");
    const originalNow = Date.now;
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    let wallNow = 1_000;
    Date.now = () => wallNow;
    try {
      const options = {
        waitMs: 0,
        now: 50_000,
        clientVersion: TEST_CLIENT_VERSION,
        credentialSnapshot: storedCredentialSnapshot,
        fetcher: (async () => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          return roster(SOL);
        }) as typeof fetch,
      };
      await ensureCodexEntitlementFreshness(poolConfig("pool-wait"), options);
      await fetchStarted.promise;

      wallNow = 5_000;
      let lateWaiterSettled = false;
      const lateWaiter = ensureCodexEntitlementFreshness(poolConfig("pool-wait"), {
        ...options,
        waitMs: 3_000,
      }).then(() => { lateWaiterSettled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(lateWaiterSettled).toBe(true);

      releaseFetch.resolve();
      await lateWaiter;
      await ensureCodexEntitlementFreshness(poolConfig("pool-wait"), {
        ...options,
        waitMs: 1_000,
      });
    } finally {
      Date.now = originalNow;
      releaseFetch.resolve();
    }
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
      // Gates at the version MEASURED upstream to actually return the gated rows, not at the
      // version the bundled snapshot happens to declare. This mock used to gate at minor >= 142,
      // which is why the suite never caught #3022: the derived floor was 0.142.2, the mock
      // accepted it, and the test stayed green while real upstream answered with no gpt-5.6.
      fetcher: (async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const version = url.searchParams.get("client_version") ?? "";
        seen.push(version);
        const minor = Number(version.split(".")[1] ?? "0");
        return minor >= 144 ? roster("gpt-5.5", SOL, TERRA, LUNA) : roster("gpt-5.5");
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

  test("the gated floor never falls below the measured upstream minimum (#3022)", () => {
    // 2.36.0 regressed exactly here: the floor is DERIVED from the bundled snapshot, and the
    // snapshot records 0.142.2 for the gpt-5.6 rows. Upstream does not return those rows until
    // 0.144.0 (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md: 0.142.2
    // answers 200 with five rows and no gpt-5.6; >= 0.144.0 answers with eight including them,
    // independently reproduced by the #2886 and #3022 reporters). So background sync asked a
    // question upstream answers with an empty gated set, and the fail-closed gate read that as
    // a confirmed denial — entitled Plus accounts lost sol/terra/luna.
    expect(compareClientVersionsForTests(GATED_MODEL_CLIENT_VERSION_FLOOR, "0.144.0"))
      .toBeGreaterThanOrEqual(0);
  });

  test("the floor is the higher of the derived and the measured minimum, not either alone", () => {
    // Tested as a COMPOSITION on synthetic inputs. Hardcoding 0.144.0 would satisfy the test
    // above while destroying the property that matters next: a refreshed snapshot declaring a
    // NEWER requirement must take over, and the measured constant must then go inert rather
    // than holding the floor down. Both directions are asserted here because only one of them
    // is exercised by the shipped data.
    const gated = new Set(["a"]);
    const compose = (rows: Array<Record<string, unknown>>) =>
      composeGatedClientVersionFloorForTests(rows, gated);

    // Snapshot below the measurement: the measurement wins. This is today's shipped state.
    expect(compose([{ slug: "a", minimal_client_version: "0.142.2" }])).toBe("0.144.0");
    // Snapshot above the measurement: the snapshot wins, and the constant is inert.
    expect(compose([{ slug: "a", minimal_client_version: "0.151.0" }])).toBe("0.151.0");
    // Equal: either answer is the same value.
    expect(compose([{ slug: "a", minimal_client_version: "0.144.0" }])).toBe("0.144.0");
    // Derivation empty — no gated row carries a usable version — still never below measured.
    expect(compose([])).toBe("0.144.0");
    expect(compose([{ slug: "a", minimal_client_version: "0.0.0" }])).toBe("0.144.0");
    // Numeric, not lexicographic: "0.99.0" must not beat "0.144.0".
    expect(compose([{ slug: "a", minimal_client_version: "0.99.0" }])).toBe("0.144.0");
  });

  test("an empty roster is not a confirmation, and is retried on the failure TTL (#3022)", async () => {
    // `{"models":[]}` parses to an empty Set, and an empty Set is truthy — so the old
    // expression `confirmed: models !== null` called it a confirmed answer and locked it in for
    // the full five-minute success TTL. An empty roster is absence of evidence, not evidence of
    // absence, and it must expire on the 15s failure TTL instead.
    //
    // Driven through the DIRECT caller path deliberately: a completed flight only writes to the
    // cache when `currentCredentialIdentity` matches the snapshot identity, and a synthetic
    // pool credential never satisfies that guard — so a test built on `credential()` would
    // measure an uncached path and prove nothing about the TTL.
    let fetches = 0;
    const empty = (async () => { fetches += 1; return Response.json({ models: [] }); }) as typeof fetch;

    const ask = (now: number) => isDirectCallerEntitledToCodexModel(
      directHeaders("tok-empty"),
      SOL,
      { fetcher: empty, now, clientVersion: "0.146.0" },
    );

    expect(await ask(1_000)).toBe(false);
    expect(fetches).toBe(1);

    // Still inside the 15s failure window: served from the cached unconfirmed entry.
    expect(await ask(1_000 + 14_999)).toBe(false);
    expect(fetches).toBe(1);

    // Past the failure TTL: exactly one refetch. Under the old five-minute success TTL this
    // stayed at 1 until 300,001 ms, which is the wrong answer held for twenty times too long.
    expect(await ask(1_000 + 15_001)).toBe(false);
    expect(fetches).toBe(2);
  });

  test("a non-empty roster still confirms the account", async () => {
    // Characterization guard, green before and after: only the EMPTY case changes. An ordinary
    // short roster must keep confirming the account and keep granting what it lists, otherwise
    // the empty-roster fix would have widened into a denial of service for everyone.
    let fetches = 0;
    const backend = (async () => { fetches += 1; return roster(SOL); }) as typeof fetch;
    const ask = (now: number) => isDirectCallerEntitledToCodexModel(
      directHeaders("tok-nonempty"),
      SOL,
      { fetcher: backend, now, clientVersion: "0.146.0" },
    );

    expect(await ask(1_000)).toBe(true);
    // And it keeps the five-minute success TTL: no refetch just past the failure window.
    expect(await ask(1_000 + 15_001)).toBe(true);
    expect(fetches).toBe(1);
  });

  test("an all-filtered roster is unconfirmed and retried on the failure TTL", async () => {
    // Rows arrived, but every one was hidden or api-disabled, so the parse yields an empty set.
    // Same situation as a zero-row response: no usable evidence. Every gated projection needs
    // both confirmation and membership, so an empty set denies identically either way — which
    // is exactly why calling it "confirmed" buys nothing and costs a five-minute wrong answer.
    let fetches = 0;
    const filtered = (async () => {
      fetches += 1;
      return Response.json({ models: [
        { slug: SOL, supported_in_api: true, visibility: "hide" },
        { slug: "gpt-disabled", supported_in_api: false, visibility: "list" },
      ] });
    }) as typeof fetch;

    const ask = (now: number) => isDirectCallerEntitledToCodexModel(
      directHeaders("tok-filtered"),
      SOL,
      { fetcher: filtered, now, clientVersion: "0.146.0" },
    );

    expect(await ask(1_000)).toBe(false);
    expect(fetches).toBe(1);
    expect(await ask(1_000 + 14_999)).toBe(false);
    expect(fetches).toBe(1);
    // The TTL half is asserted separately from the flag: flipping `confirmed` while leaving the
    // success TTL in place would pass an assertion about the flag alone.
    expect(await ask(1_000 + 15_001)).toBe(false);
    expect(fetches).toBe(2);
  });
});
