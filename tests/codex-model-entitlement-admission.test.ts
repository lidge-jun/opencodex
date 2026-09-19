import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
} from "../src/codex/main-account";
import { resolveAdmittedCodexModelEntitlements } from "../src/codex/model-entitlement-admission";
import {
  ensureCodexEntitlementFreshness,
  resetCodexModelEntitlementCacheForTests,
  type CodexModelEntitlementResolveOptions,
} from "../src/codex/model-entitlements";
import { NativeProfileError } from "../src/codex/native-profile-types";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";

const emptySnapshot = {
  modelsByAccount: new Map<string, ReadonlySet<string>>(),
  clientVersionByAccount: new Map<string, string>(),
  confirmedAccountIds: new Set<string>(),
  credentialIdentities: new Map<string, string>(),
};

describe("Codex model entitlement admission", () => {
  test("excludes native main before credential discovery when lifecycle admission is blocked", async () => {
    let received: CodexModelEntitlementResolveOptions | undefined;

    await resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, {}, {
      acquireNativeMain: () => null,
      resolve: async (_config, options) => {
        received = options;
        return emptySnapshot;
      },
    });

    expect(received?.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });

  test("holds the lifecycle lease through credential discovery", async () => {
    const events: string[] = [];
    let released = false;

    await resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, {}, {
      acquireNativeMain: () => ({ release: () => {
        released = true;
        events.push("lifecycle-release");
      } }),
      resolve: async () => {
        expect(released).toBe(false);
        events.push("credential-discovery");
        return emptySnapshot;
      },
    });

    expect(events).toEqual([
      "credential-discovery",
      "lifecycle-release",
    ]);
  });

  test("falls back to Pool-only discovery when the credential claim is refused", async () => {
    const exclusions: boolean[] = [];
    let calls = 0;

    await resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, {}, {
      acquireNativeMain: () => ({ release: () => undefined }),
      resolve: async (_config, options) => {
        calls += 1;
        if (calls === 1) {
          throw new NativeProfileError("NATIVE_MAIN_CLAIM_BUSY", "busy", 503, true);
        }
        exclusions.push(options.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID) === true);
        return emptySnapshot;
      },
    });

    expect(exclusions).toEqual([true]);
  });

  test("a foreign credential owner or a failed grant still resolves the Pool", async () => {
    for (const makeError of [
      () => new MainAuthJsonChangedDuringRefreshError(),
      () => new MainAccountTokenRefreshError("reauth"),
      () => new NativeProfileError("NATIVE_MAIN_CLAIM_BUSY", "busy", 503, true),
    ]) {
      const exclusions: boolean[] = [];
      let calls = 0;

      await resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, {}, {
        acquireNativeMain: () => ({ release: () => undefined }),
        resolve: async (_config, options) => {
          calls += 1;
          if (calls === 1) throw makeError();
          exclusions.push(options.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID) === true);
          return emptySnapshot;
        },
      });

      expect(exclusions).toEqual([true]);
    }
  });

  test("propagates failures that are not credential-ownership errors", async () => {
    const failure = new Error("upstream exploded");

    await expect(resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, {}, {
      acquireNativeMain: () => ({ release: () => undefined }),
      resolve: async () => {
        throw failure;
      },
    })).rejects.toBe(failure);
  });

  test("skips the fences for a caller-supplied roster or an already-excluded main", async () => {
    let leaseAttempts = 0;
    const seen: CodexModelEntitlementResolveOptions[] = [];
    const deps = {
      acquireNativeMain: () => {
        leaseAttempts += 1;
        return null;
      },
      resolve: async (_config: unknown, options: CodexModelEntitlementResolveOptions) => {
        seen.push(options);
        return emptySnapshot;
      },
    };

    await resolveAdmittedCodexModelEntitlements({ codexAccounts: [] }, { credentials: [] }, deps);
    await resolveAdmittedCodexModelEntitlements(
      { codexAccounts: [] },
      { excludeAccountIds: new Set([MAIN_CODEX_ACCOUNT_ID]) },
      deps,
    );

    expect(leaseAttempts).toBe(0);
    expect(seen[0]?.credentials).toEqual([]);
    expect(seen[1]?.excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID)).toBe(true);
  });
});

describe("entitlement freshness admission", () => {
  let home: ReturnType<typeof installIsolatedCodexHome>;

  beforeEach(() => {
    home = installIsolatedCodexHome("ocx-entitlement-admission-");
  });

  afterEach(() => {
    home.restore();
    resetCodexModelEntitlementCacheForTests();
  });

  test("a denied native-main admission drops main from the refresh workset", async () => {
    const snapshots: string[] = [];

    await ensureCodexEntitlementFreshness(
      { codexAccounts: [{ id: "pool-fenced", email: "pool-fenced@example.test", isMain: false }] },
      {
        clientVersion: "0.146.0",
        waitMs: 1_000,
        credentialSnapshot: async accountId => {
          snapshots.push(accountId);
          return null;
        },
        nativeMainCredentialAdmission: async operation => operation(new Set([MAIN_CODEX_ACCOUNT_ID])),
      },
    );

    expect(snapshots).toContain("pool-fenced");
    expect(snapshots).not.toContain(MAIN_CODEX_ACCOUNT_ID);
  });

  test("an admitted freshness refresh snapshots main inside the claim", async () => {
    const events: string[] = [];

    await ensureCodexEntitlementFreshness({ codexAccounts: [] }, {
      clientVersion: "0.146.0",
      waitMs: 1_000,
      credentialSnapshot: async accountId => {
        events.push(`snapshot:${accountId}`);
        return null;
      },
      nativeMainCredentialAdmission: async operation => {
        events.push("admission-enter");
        const result = await operation(new Set());
        events.push("admission-exit");
        return result;
      },
    });

    const enteredAt = events.indexOf("admission-enter");
    const mainSnapshotAt = events.indexOf(`snapshot:${MAIN_CODEX_ACCOUNT_ID}`);
    const exitedAt = events.indexOf("admission-exit");
    expect(enteredAt).toBeGreaterThanOrEqual(0);
    expect(mainSnapshotAt).toBeGreaterThan(enteredAt);
    expect(exitedAt).toBeGreaterThan(mainSnapshotAt);
  });
});
