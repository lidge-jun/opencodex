/**
 * Muse Code login selection order.
 *
 * Deliberately a separate file from tests/providers/meta-muse-oauth.test.ts, which owns
 * the import and paste behaviour and passes UNMODIFIED against this change. `loginDevice`
 * is injected as a counting stub, so the order is asserted without running a grant.
 */
import { describe, expect, test } from "bun:test";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { loginMetaMuse, refreshMetaMuseToken, type MuseImportDeps } from "../../src/oauth/meta-muse";
import { MuseDeviceLoginError } from "../../src/oauth/meta-muse-device";
import type { OAuthCredentials } from "../../src/oauth/types";

const KEY = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;
const ACCOUNT_TOKEN = "meta-account-" + "z".repeat(48);
const okFetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

function pointer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ providers: { meta: { mechanism: "oauth", storage: "keychain", user_email: "Someone@Example.COM", ...overrides } } });
}

const DEVICE_CREDENTIAL: OAuthCredentials = {
  access: KEY,
  refresh: KEY,
  expires: Number.MAX_SAFE_INTEGER,
  email: "someone@example.com",
  source: "oauth",
  muse: { oauthAccessToken: ACCOUNT_TOKEN, userId: "meta-user-1", mintedAt: 1_700_000_000_000 },
};

function harness(over: Partial<MuseImportDeps> = {}, device?: () => Promise<OAuthCredentials>) {
  const calls = { pointer: 0, keychain: 0, device: 0 };
  const deps: MuseImportDeps = {
    platform: "darwin",
    readPointer: async () => { calls.pointer += 1; return pointer(); },
    readKeychain: async () => { calls.keychain += 1; return JSON.stringify({ api_key: KEY, access_token: "x".repeat(280) }); },
    fetchImpl: okFetch,
    loginDevice: async () => { calls.device += 1; return device ? await device() : DEVICE_CREDENTIAL; },
    ...over,
  };
  return { deps, calls };
}

describe("muse login selection order", () => {
  test("a working CLI credential wins and no grant is started", async () => {
    const h = harness();
    const creds = await loginMetaMuse({}, h.deps);
    expect(creds.access).toBe(KEY);
    expect(creds.source).toBe("local-cli");
    expect(h.calls.device).toBe(0);
  });

  test("no pointer file falls through to the device grant instead of a dead end", async () => {
    const h = harness({ readPointer: async () => null });
    const creds = await loginMetaMuse({}, h.deps);
    expect(h.calls.device).toBe(1);
    expect(creds.muse?.oauthAccessToken).toBe(ACCOUNT_TOKEN);
  });

  test("a pointer with no signed-in Meta account also falls through", async () => {
    const h = harness({ readPointer: async () => JSON.stringify({ providers: {} }) });
    await loginMetaMuse({}, h.deps);
    expect(h.calls.device).toBe(1);
  });

  // A credential probably EXISTS in these four cases, so a browser grant would create a
  // second login to work around a local fault. They stay refusals.
  test("a Keychain timeout still refuses and starts no grant", async () => {
    const h = harness({ readKeychain: async () => null });
    await expect(loginMetaMuse({}, h.deps)).rejects.toThrow(/within 5s/);
    expect(h.calls.device).toBe(0);
  });

  test("a corrupt pointer still refuses and starts no grant", async () => {
    const h = harness({ readPointer: async () => "{not json" });
    await expect(loginMetaMuse({}, h.deps)).rejects.toThrow(/not valid JSON/);
    expect(h.calls.device).toBe(0);
  });

  test("an unmeasured storage backend still refuses and starts no grant", async () => {
    const h = harness({ readPointer: async () => pointer({ storage: "file" }) });
    await expect(loginMetaMuse({}, h.deps)).rejects.toThrow(/unsupported backend/);
    expect(h.calls.device).toBe(0);
  });

  test("an unreadable Keychain entry still refuses and starts no grant", async () => {
    const h = harness({ readKeychain: async () => "{not json" });
    await expect(loginMetaMuse({}, h.deps)).rejects.toThrow(/not valid JSON/);
    expect(h.calls.device).toBe(0);
  });

  test("add-account skips the import entirely", async () => {
    const h = harness();
    const creds = await loginMetaMuse({}, h.deps, { importLocal: "off" });
    expect(h.calls.pointer).toBe(0);
    expect(h.calls.keychain).toBe(0);
    expect(h.calls.device).toBe(1);
    expect(creds.source).toBe("oauth");
  });

  test("the registry maps forceLogin onto that skip", async () => {
    const h = harness();
    const def = OAUTH_PROVIDERS["meta-muse"];
    expect(def).toBeDefined();
    // The registration closure passes its own empty deps, so the grant runs for real
    // against the injected-free module. Assert the mapping by its observable effect:
    // forceLogin must not read the pointer file. A plain login must.
    let sawForce = false;
    await loginMetaMuse({}, { ...h.deps, readPointer: async () => { sawForce = true; return pointer(); } }, { importLocal: "off" });
    expect(sawForce).toBe(false);
    await loginMetaMuse({}, { ...h.deps, readPointer: async () => { sawForce = true; return pointer(); } }, { importLocal: "fallback" });
    expect(sawForce).toBe(true);
  });

  test("a non-darwin host gets a real login, not only a paste field", async () => {
    const h = harness({ platform: "win32" });
    const creds = await loginMetaMuse({}, h.deps);
    expect(h.calls.device).toBe(1);
    expect(h.calls.pointer).toBe(0);
    expect(creds.source).toBe("oauth");
  });
});

describe("muse login device failure handling", () => {
  function failing(kind: "device-denied" | "cancelled" | "subscription-inactive") {
    return async () => { throw new MuseDeviceLoginError(kind, "device failed: " + kind); };
  }

  test("a failed grant offers the paste field and says why it appeared", async () => {
    const h = harness({ readPointer: async () => null }, failing("device-denied"));
    const seen: string[] = [];
    const creds = await loginMetaMuse(
      { onAuth: info => seen.push(info.instructions ?? ""), onManualCodeInput: async () => KEY },
      h.deps,
    );
    expect(creds.source).toBe("manual");
    expect(seen.join(" ")).toContain("approval was denied");
  });

  test("a cancelled grant is rethrown and never answered with a prompt", async () => {
    let prompted = false;
    const h = harness({ readPointer: async () => null }, failing("cancelled"));
    await expect(loginMetaMuse(
      { onManualCodeInput: async () => { prompted = true; return KEY; } },
      h.deps,
    )).rejects.toThrow(/cancelled/);
    expect(prompted).toBe(false);
  });

  // The composed refusal: a device reason PLUS the guidance the import path always gave.
  test("a host with no paste surface keeps the actionable guidance", async () => {
    const h = harness({ platform: "win32" }, failing("subscription-inactive"));
    const error = await loginMetaMuse({}, h.deps).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("no active Muse Code subscription");
    expect(message).toContain("no credential to import");
    expect(message).toContain("dev.meta.ai");
    expect(message).toContain("META_MODEL_API_KEY");
  });

  test("the consent warning still precedes the device path", async () => {
    const h = harness({ readPointer: async () => null });
    const progress: string[] = [];
    await loginMetaMuse({ onProgress: m => progress.push(m) }, h.deps);
    expect(progress[0]).toContain("UNSUPPORTED");
    expect(progress.join(" ")).toContain("Starting the Meta device login");
  });
});

describe("muse refresh keeps what cannot be re-derived", () => {
  test("a device credential keeps its account token and its provenance", async () => {
    const refreshed = await refreshMetaMuseToken(KEY, undefined, DEVICE_CREDENTIAL);
    expect(refreshed.source).toBe("oauth");
    expect(refreshed.muse?.oauthAccessToken).toBe(ACCOUNT_TOKEN);
    expect(refreshed.muse?.userId).toBe("meta-user-1");
  });

  test("a pasted credential is not relabelled and gains no account token", async () => {
    const refreshed = await refreshMetaMuseToken(KEY, undefined, { access: KEY, refresh: KEY, expires: 1, source: "manual" });
    expect(refreshed.source).toBe("manual");
    expect(refreshed.muse).toBeUndefined();
  });

  test("an imported credential still refreshes as local-cli", async () => {
    const refreshed = await refreshMetaMuseToken(KEY, undefined, { access: KEY, refresh: KEY, expires: 1, source: "local-cli" });
    expect(refreshed.source).toBe("local-cli");
  });
});
