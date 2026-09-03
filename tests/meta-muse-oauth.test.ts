/**
 * Meta Muse Code credential provider (`meta-muse`).
 *
 * This provider reuses the API key the Muse Code CLI stores — a credential Meta scopes
 * to its own CLI. It exists because the repository owner authorized it explicitly, and
 * the tests below pin the guards that make that choice informed rather than silent:
 * the warning fires before any read, the note discloses what is unsupported, the login
 * cannot be spawned or refreshed into a different identity, and the credential never
 * reaches a message or a status object.
 */
import { describe, expect, test } from "bun:test";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { loginMetaMuse, refreshMetaMuseToken } from "../src/oauth/meta-muse";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { supportsPerAccountQuota } from "../src/providers/quota";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

const MODELS = ["muse-spark-1.3", "muse-spark-1.3-contributor"] as const;

/** A synthetic key of the measured grammar. Assembled at runtime, never a real value. */
const CANARY = `LLM|${"1".repeat(16)}|${"c".repeat(27)}`;

function entry() {
  const found = getProviderRegistryEntry("meta-muse");
  if (!found) throw new Error("missing meta-muse registry entry");
  return found;
}

function pointer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 2,
    providers: { meta: { mechanism: "oauth", storage: "keychain", user_email: "Someone@Example.COM", ...overrides } },
  });
}

const okFetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

function deps(over: Partial<Parameters<typeof loginMetaMuse>[1]> = {}) {
  return {
    platform: "darwin",
    readPointer: async () => pointer(),
    readKeychain: async () => JSON.stringify({ secret_schema_version: 1, api_key: CANARY, access_token: "x".repeat(280) }),
    fetchImpl: okFetch,
    ...over,
  };
}

describe("meta-muse registry entry", () => {
  test("routes to Meta's Responses endpoint as an OAuth provider", () => {
    expect(entry().baseUrl).toBe("https://api.meta.ai/v1");
    expect(entry().adapter).toBe("openai-responses");
    expect(entry().authKind).toBe("oauth");
    expect(entry().oauthId).toBe("meta-muse");
  });

  test("reuses the ladder, window, modalities and identity wire map from the key provider", () => {
    for (const id of MODELS) {
      expect(entry().modelReasoningEfforts?.[id]).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
      expect(entry().modelReasoningEffortMap?.[id]?.minimal).toBe("minimal");
      expect(entry().modelContextWindows?.[id]).toBe(1_048_576);
      expect(entry().modelInputModalities?.[id]).toEqual(["text", "image"]);
    }
  });

  test("keeps live discovery off — the real roster carries image and voice models", () => {
    expect(entry().liveModels).toBeFalsy();
    expect(entry().models).toEqual([...MODELS]);
  });

  test("the note discloses every unsupported-use fact a user needs before opting in", () => {
    const note = entry().note ?? "";
    expect(note).toContain("UNSUPPORTED");
    expect(note).toContain("treat every call as billable");
    expect(note).toContain("auth store");
    // The env-var trap: Meta calls it MODEL_API_KEY, opencodex reads META_MODEL_API_KEY.
    expect(note).toContain("META_MODEL_API_KEY");
    // The quota sentence must stay true in both directions: it now claims a reading,
    // so it must also say why that reading can be old and where it is absent.
    expect(note).toContain("shows the last observed value with its age");
    expect(note).toContain("no endpoint to query them on demand");
    expect(note).toContain("translated (non-passthrough) turns report none");
    expect(note).not.toContain("does not yet read or display it");
  });

  test("never generates unattended traffic on a vendor-restricted credential", () => {
    expect(OAUTH_PROVIDERS["meta-muse"]?.defaultRefreshPolicy).toBe("disabled");
  });

  /*
   * supportsPerAccountQuota gates fetchAccountQuota, whose fallback sends any
   * non-Kiro/non-Antigravity bearer to Anthropic's usage endpoint. Flipping this without
   * a dedicated branch would ship a Meta key to Anthropic.
   */
  test("stays out of the per-account quota probe path", () => {
    expect(supportsPerAccountQuota("meta-muse")).toBe(false);
  });

  test("does not capture the live command-code meta/ model namespace", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "command-code",
      providers: {
        "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", apiKey: "cc", authMode: "key" },
        "meta-muse": { adapter: "openai-responses", baseUrl: "https://api.meta.ai/v1", apiKey: "mm", authMode: "oauth" },
      },
    };
    expect(routeModel(config, "meta/muse-spark-1.3").providerName).toBe("command-code");
    expect(routeModel(config, "meta-muse/muse-spark-1.3").providerName).toBe("meta-muse");
  });
});

describe("meta-muse credential import", () => {
  test("warns before it reads anything", async () => {
    const seen: string[] = [];
    let readPointerCalled = false;
    await loginMetaMuse(
      { onProgress: m => seen.push(m) },
      deps({ readPointer: async () => { readPointerCalled = true; expect(seen.length).toBeGreaterThan(0); return pointer(); } }),
    );
    expect(readPointerCalled).toBe(true);
    const warning = seen[0] ?? "";
    expect(warning).toContain("UNSUPPORTED");
    expect(warning).toContain("billable");
    expect(warning).toContain("meta-model");
  });

  test("imports the api_key, not the access_token that 401s", async () => {
    const creds = await loginMetaMuse({}, deps());
    expect(creds.access).toBe(CANARY);
    expect(creds.refresh).toBe(CANARY);
    expect(creds.expires).toBe(Number.MAX_SAFE_INTEGER);
    expect(creds.source).toBe("local-cli");
  });

  test("carries a normalized email, and no accountId, so the display mask applies", async () => {
    const creds = await loginMetaMuse({}, deps());
    expect(creds.email).toBe("someone@example.com");
    expect(creds.accountId).toBeUndefined();
  });

  test("a controller without a signal still logs in", async () => {
    // AbortSignal.any([undefined, ...]) throws; the CLI controller supplies no signal.
    await expect(loginMetaMuse({}, deps())).resolves.toBeDefined();
  });

  test("an aborted controller signal aborts the login", async () => {
    const ac = new AbortController();
    ac.abort();
    const failing = (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(loginMetaMuse({ signal: ac.signal }, deps({ fetchImpl: failing }))).rejects.toThrow();
  });

  /*
   * `security` can raise an interactive approval prompt that nobody answers on a headless
   * or locked machine. That read happens BEFORE the validation timeout is created, so
   * without its own deadline the login would hang with no bound at all.
   */
  test("a blocked Keychain read fails instead of hanging", async () => {
    const started = Date.now();
    await expect(loginMetaMuse({}, deps({
      // Mimics the real reader's contract: it resolves null once its deadline fires.
      readKeychain: async () => null,
    }))).rejects.toThrow(/within 5s/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the caller's abort signal is handed to the Keychain reader", async () => {
    const ac = new AbortController();
    let received: AbortSignal | undefined;
    await loginMetaMuse({ signal: ac.signal }, deps({
      readKeychain: async (signal) => {
        received = signal;
        return JSON.stringify({ api_key: CANARY });
      },
    }));
    expect(received).toBe(ac.signal);
  });

  for (const [label, over] of [
    ["a non-darwin platform", { platform: "linux" }],
    ["no credential file", { readPointer: async () => null }],
    ["a malformed credential file", { readPointer: async () => "{not json" }],
    ["no signed-in Meta account", { readPointer: async () => JSON.stringify({ providers: {} }) }],
    ["an unverified storage backend", { readPointer: async () => pointer({ storage: "file" }) }],
    ["an unreadable keychain", { readKeychain: async () => null }],
    ["a malformed keychain payload", { readKeychain: async () => "{not json" }],
    ["a payload with only an access_token", { readKeychain: async () => JSON.stringify({ access_token: "x".repeat(280) }) }],
    ["a key of the wrong shape", { readKeychain: async () => JSON.stringify({ api_key: "not-a-meta-key" }) }],
  ] as const) {
    test(`refuses ${label} with an actionable message`, async () => {
      await expect(loginMetaMuse({}, deps(over as never))).rejects.toThrow();
    });
  }

  test("a rejected credential fails without echoing it", async () => {
    const denied = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(loginMetaMuse({}, deps({ fetchImpl: denied }))).rejects.toThrow(/401/);
  });

  /*
   * The canary must never appear anywhere a human or a log can read it. This is the
   * assertion that would catch a well-meaning "include the key in the error for
   * debugging" change.
   */
  test("no failure path echoes the credential", async () => {
    const denied = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const progress: string[] = [];
    let message = "";
    try {
      await loginMetaMuse({ onProgress: m => progress.push(m) }, deps({ fetchImpl: denied }));
    } catch (error) {
      message = String((error as Error).message) + String((error as Error).stack ?? "");
    }
    expect(message).not.toContain(CANARY);
    for (const line of progress) expect(line).not.toContain(CANARY);
  });
});

describe("meta-muse refresh", () => {
  test("returns the same static key and reads no credential store", async () => {
    // Re-importing here would let a DIFFERENT Muse account silently overwrite this slot.
    const creds = await refreshMetaMuseToken(CANARY);
    expect(creds.access).toBe(CANARY);
    expect(creds.refresh).toBe(CANARY);
    expect(creds.expires).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("an empty key is refused rather than replayed", async () => {
    await expect(refreshMetaMuseToken("")).rejects.toThrow(/ocx login meta-muse/);
  });
});
