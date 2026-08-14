import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  hardenedIdentities,
  NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES,
  rememberHardenedIdentity,
} from "../src/codex/native-main-claim";

beforeEach(() => {
  hardenedIdentities.clear();
});

afterEach(() => {
  hardenedIdentities.clear();
});

describe("native-main hardened identity cache", () => {
  test("cache hit returns the stored identity", () => {
    rememberHardenedIdentity("/claim", "1:2");

    expect(hardenedIdentities.get("/claim")).toBe("1:2");
  });

  test("eviction removes the oldest identity at the cap", () => {
    for (let index = 0; index <= NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES; index += 1) {
      rememberHardenedIdentity(`/claim-${index}`, `identity-${index}`);
    }

    expect(hardenedIdentities.size).toBe(NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES);
    expect(hardenedIdentities.has("/claim-0")).toBe(false);
    expect(hardenedIdentities.get(`/claim-${NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES}`))
      .toBe(`identity-${NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES}`);
  });

  test("re-insertion refreshes identity order", () => {
    for (let index = 0; index < NATIVE_MAIN_HARDENED_IDENTITY_MAX_ENTRIES; index += 1) {
      rememberHardenedIdentity(`/claim-${index}`, `identity-${index}`);
    }
    rememberHardenedIdentity("/claim-0", "identity-refreshed");
    rememberHardenedIdentity("/claim-new", "identity-new");

    expect(hardenedIdentities.get("/claim-0")).toBe("identity-refreshed");
    expect(hardenedIdentities.has("/claim-1")).toBe(false);
  });
});
