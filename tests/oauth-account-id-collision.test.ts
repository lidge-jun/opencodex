import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
} from "../src/lib/windows-secret-acl";
import {
  getAccountSet,
  getCredential,
  saveCredential,
} from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-account-id-collision-test");
let previousOpencodexHome: string | undefined;

const COLLIDING_ACCOUNT_A = "account-collision-16138";
const COLLIDING_ACCOUNT_B = "account-collision-28806";

describe("OAuth account id collision hardening", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    resetHardenedStateForTests();
    setIcaclsRunnerForTests(() => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "",
    }));
  });

  afterEach(() => {
    setIcaclsRunnerForTests(null);
    resetHardenedStateForTests();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("distinct identities that collide on the historical 32-bit prefix get distinct slots", async () => {
    // sha256(account-collision-16138) and sha256(account-collision-28806) both
    // start with da1e26d2. The historical 8-hex id therefore aliased these
    // two accounts and made active-account lookup return the wrong credential.
    await saveCredential("anthropic", {
      access: "access-a",
      refresh: "refresh-a",
      expires: Date.now() + 3600_000,
      accountId: COLLIDING_ACCOUNT_A,
    });
    await saveCredential("anthropic", {
      access: "access-b",
      refresh: "refresh-b",
      expires: Date.now() + 3600_000,
      accountId: COLLIDING_ACCOUNT_B,
    });

    const set = getAccountSet("anthropic");
    expect(set).not.toBeNull();
    expect(set!.accounts).toHaveLength(2);
    expect(new Set(set!.accounts.map(account => account.id)).size).toBe(2);
    expect(set!.accounts.every(account => account.id.length === 32)).toBe(true);
    expect(getCredential("anthropic")?.accountId).toBe(COLLIDING_ACCOUNT_B);
    expect(getCredential("anthropic")?.access).toBe("access-b");
  });

  test("existing persisted 32-bit account ids remain valid and are not rewritten", async () => {
    const authPath = join(TEST_DIR, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      anthropic: {
        activeAccountId: "deadbeef",
        accounts: [{
          id: "deadbeef",
          credential: {
            access: "old-access",
            refresh: "old-refresh",
            expires: Date.now() + 3600_000,
            accountId: "existing-account",
          },
        }],
      },
    }));

    expect(getAccountSet("anthropic")?.activeAccountId).toBe("deadbeef");

    await saveCredential("anthropic", {
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 7200_000,
      accountId: "existing-account",
    });

    const set = getAccountSet("anthropic");
    expect(set?.activeAccountId).toBe("deadbeef");
    expect(set?.accounts[0]?.id).toBe("deadbeef");
    expect(getCredential("anthropic")?.access).toBe("rotated-access");
  });
});
