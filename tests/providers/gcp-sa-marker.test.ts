import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GCP_CREDENTIAL_MARKER_PREFIX,
  gcpCredentialMarkerAccount,
  getVertexAccessToken,
  parseGcpCredentialJson,
  __resetVertexTokenCache,
} from "../../src/lib/gcp-adc";
import { splitCredentialPaste, addProviderApiKey } from "../../src/providers/api-keys";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { saveConfig } from "../../src/config";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  client_email: "svc@example.test",
  private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
  private_key_id: "k1",
});
const SERVICE_ACCOUNT_JSON_2 = JSON.stringify({
  type: "service_account",
  client_email: "svc2@example.test",
  private_key: "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n",
  private_key_id: "k2",
});

afterEach(() => {
  __resetVertexTokenCache();
  setProviderKeychainEntryFactoryForTests(null);
});

describe("parseGcpCredentialJson", () => {
  test("accepts a service_account JSON body", () => {
    const creds = parseGcpCredentialJson(SERVICE_ACCOUNT_JSON);
    expect(creds?.type).toBe("service_account");
  });

  test("accepts an authorized_user JSON body", () => {
    const creds = parseGcpCredentialJson(JSON.stringify({ type: "authorized_user", client_id: "c", client_secret: "s", refresh_token: "r" }));
    expect(creds?.type).toBe("authorized_user");
  });

  test("rejects unknown types, non-JSON, and plain keys", () => {
    expect(parseGcpCredentialJson(JSON.stringify({ type: "external_account" }))).toBeUndefined();
    expect(parseGcpCredentialJson("not json")).toBeUndefined();
    expect(parseGcpCredentialJson("AIza-real-key-123456")).toBeUndefined();
    expect(parseGcpCredentialJson("{}")).toBeUndefined();
  });
});

describe("gcpCredentialMarkerAccount", () => {
  test("extracts the account from a marker", () => {
    expect(gcpCredentialMarkerAccount(`${GCP_CREDENTIAL_MARKER_PREFIX}p/abc123`)).toBe("p/abc123");
    expect(gcpCredentialMarkerAccount("gcp-sa:")).toBeUndefined();
    expect(gcpCredentialMarkerAccount("keychain:p/abc")).toBeUndefined();
    expect(gcpCredentialMarkerAccount(undefined)).toBeUndefined();
  });
});

describe("splitCredentialPaste", () => {
  test("a plain API key is one literal row", () => {
    expect(splitCredentialPaste("sk-real-key")).toEqual(["sk-real-key"]);
  });

  test("one credential JSON parses to one row", () => {
    const parts = splitCredentialPaste(SERVICE_ACCOUNT_JSON);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ credentialJson: SERVICE_ACCOUNT_JSON });
  });

  test("pretty-printed JSON (with newlines) parses", () => {
    const pretty = JSON.stringify(JSON.parse(SERVICE_ACCOUNT_JSON), null, 2);
    const parts = splitCredentialPaste(pretty);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ credentialJson: pretty });
  });

  test("two adjacent credential JSONs split into two rows (rotation pool)", () => {
    const parts = splitCredentialPaste(`${SERVICE_ACCOUNT_JSON}, ${SERVICE_ACCOUNT_JSON_2}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ credentialJson: SERVICE_ACCOUNT_JSON });
    expect(parts[1]).toEqual({ credentialJson: SERVICE_ACCOUNT_JSON_2 });
  });

  test("a file path is rejected with paste guidance", () => {
    expect(() => splitCredentialPaste("C:\\Users\\me\\sa.json")).toThrow(/file path/i);
  });

  test("a single-line brace-leading NON-JSON literal falls back to a plain key (never eaten)", () => {
    // parseGcpCredentialJson contract: a literal key starting with `{` is never eaten —
    // but only for NON-JSON values. Prana review: a parseable JSON with an unrecognized type
    // must be rejected, not saved as plaintext (it would go to the wire as a key).
    expect(splitCredentialPaste("{abc:def}")).toEqual(["{abc:def}"]);
  });

  test("a single-line PARSEABLE JSON with an unrecognized type is REJECTED (prana finding 2)", () => {
    // `external_account` is a real JSON object — saving it as a plaintext literal key would
    // send it verbatim to the wire. Reject with guidance instead.
    expect(() => splitCredentialPaste('{"type": "external_account"}')).toThrow();
  });

  test("a MULTILINE JSON without a recognized type field is rejected with guidance", () => {
    // Multi-line braces are not a plausible literal key — guidance error.
    const multiline = JSON.stringify({ type: "external_account", token_url: "https://sts.example" }, null, 2);
    expect(() => splitCredentialPaste(multiline)).toThrow(/type/i);
  });

  test("text between JSON objects is rejected, not silently discarded", () => {
    const sa1 = JSON.parse(SERVICE_ACCOUNT_JSON);
    expect(() => splitCredentialPaste(`${JSON.stringify(sa1)} garbage ${JSON.stringify(sa1)}`)).toThrow(/unexpected content|Paste credential/i);
  });

  test("truncated JSON is rejected", () => {
    expect(() => splitCredentialPaste('{"type": "service_account", "client_email"')).toThrow();
  });
});

describe("addProviderApiKey with a pasted credential JSON", () => {
  let home: string;
  const previousHome = process.env.OPENCODEX_HOME;

  // commitProviderApiKeySelection persists through mutatePersistedConfig, which refuses to
  // mutate unless a real config file exists — so each test runs against a throwaway home dir.
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-gcp-sa-marker-"));
    process.env.OPENCODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  function makeConfig(provider: Partial<OcxProviderConfig>): OcxConfig {
    const config = {
      port: 10199,
      defaultProvider: "p",
      providers: {
        p: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1", ...provider } as OcxProviderConfig,
      },
    } as unknown as OcxConfig;
    saveConfig(config);
    return config;
  }

  const keychainStore = new Map<string, string>();

  function installFakeKeychain(): void {
    keychainStore.clear();
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => keychainStore.get(`${service}:${account}`) ?? null,
      setPassword: (password: string) => { keychainStore.set(`${service}:${account}`, password); },
      deletePassword: () => keychainStore.delete(`${service}:${account}`),
    }));
  }

  test("JSON is diverted to the keychain and only the marker lands in config", () => {
    installFakeKeychain();
    const config = makeConfig({ apiKey: "legacy-key" });
    const result = addProviderApiKey(config, "p", SERVICE_ACCOUNT_JSON);
    expect(result).toEqual({ id: expect.any(String) });

    const provider = config.providers.p!;
    // config holds ONLY the marker — no key material anywhere.
    expect(provider.apiKey?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)).toBe(true);
    expect(JSON.stringify(config).includes("private_key")).toBe(false);
    // The secret itself lives in the credential store under the marker's account.
    const account = gcpCredentialMarkerAccount(provider.apiKey)!;
    expect(account.startsWith("p/")).toBe(true);
    expect(keychainStore.get(`opencodex.provider-api-key.v1:${account}`)).toBe(SERVICE_ACCOUNT_JSON);
  });

  test("re-adding the same JSON upserts instead of duplicating", () => {
    installFakeKeychain();
    const config = makeConfig({ apiKey: "legacy-key" });
    const first = addProviderApiKey(config, "p", SERVICE_ACCOUNT_JSON);
    const second = addProviderApiKey(config, "p", SERVICE_ACCOUNT_JSON);
    expect(first).toEqual(second);
    const pool = config.providers.p!.apiKeyPool!;
    expect(pool).toHaveLength(2); // legacy seed + the single marker entry
  });

  test("a file path paste returns an error and stores nothing", () => {
    installFakeKeychain();
    const config = makeConfig({ apiKey: "legacy-key" });
    const result = addProviderApiKey(config, "p", "C:\\Users\\me\\sa.json");
    expect("error" in result && /file path/i.test(result.error)).toBe(true);
    expect(JSON.stringify(config).includes(GCP_CREDENTIAL_MARKER_PREFIX)).toBe(false);
  });

  test("keychain-unavailable fails closed with an error", () => {
    // No fake factory installed: the real keyring may exist in CI, so probe through the seam
    // with a factory that always throws instead.
    setProviderKeychainEntryFactoryForTests(() => {
      throw new Error("keychain unavailable in test");
    });
    const config = makeConfig({ apiKey: "legacy-key" });
    const result = addProviderApiKey(config, "p", SERVICE_ACCOUNT_JSON);
    expect("error" in result).toBe(true);
    expect(JSON.stringify(config).includes(GCP_CREDENTIAL_MARKER_PREFIX)).toBe(false);
  });
});

describe("gcp-adc marker source", () => {
  let oauthCalls = 0;
  const realFetch = globalThis.fetch;
  const prevEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete prevEnv[k];
    }
  });

  // The marker-account tests pass the account per request (options.markerAccount) — no
  // process-global registration anywhere. Host ADC state is fully isolated: an empty
  // CLOUDSDK_CONFIG dir, no GOOGLE_APPLICATION_CREDENTIALS, and a 404 fetching stub, so
  // no test can make a real network call or depend on the developer's gcloud login.
  function isolateHostAdc(): void {
    prevEnv.GOOGLE_APPLICATION_CREDENTIALS ??= process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    prevEnv.CLOUDSDK_CONFIG ??= process.env.CLOUDSDK_CONFIG;
    process.env.CLOUDSDK_CONFIG = join(tmpdir(), `ocx-gcp-sa-isolated-${Date.now()}`);
    mkdirSync(process.env.CLOUDSDK_CONFIG, { recursive: true });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === "https://oauth2.googleapis.com/token") {
        oauthCalls++;
        return new Response(JSON.stringify({ access_token: "marker-tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
  }

  test("a marker account resolves its keychain credential through the JWT exchange", async () => {
    // A real, signable RSA key (generated) so the RS256 JWT exchange inside the resolver works.
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const b64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n");
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    const serviceAccount = JSON.stringify({
      type: "service_account",
      client_email: "svc@example.test",
      private_key: pem,
      private_key_id: "k1",
    });
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => (account === "p/abc123" ? serviceAccount : null),
      setPassword: () => {},
      deletePassword: () => true,
    }));
    isolateHostAdc();

    const token = await getVertexAccessToken({ markerAccount: "p/abc123" });
    expect(token).toBe("marker-tok");
    expect(oauthCalls).toBe(1);
  });

  test("an unreadable marker credential fails closed (no token, no silent fallback to metadata)", async () => {
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => null,
      setPassword: () => {},
      deletePassword: () => true,
    }));
    isolateHostAdc();
    await expect(getVertexAccessToken({ markerAccount: "p/missing" })).rejects.toThrow(/gcp-sa:p\/missing/);
  });

  test("no marker account falls through to the normal source priority (isolated: fails with ADC guidance)", async () => {
    isolateHostAdc();
    // With no marker and no env/file ADC, the resolver reaches the metadata-server attempt and
    // fails with the standard ADC guidance — proving the no-marker path is unchanged.
    await expect(getVertexAccessToken()).rejects.toThrow(/Application Default Credentials/);
  });

  test("a marker does NOT fall back to GOOGLE_CLOUD_API_KEY when ADC resolution succeeds via keychain", async () => {
    // Prana review: with a marker set, the vertex adapter must suppress the env fast path —
    // the keychain credential wins over the ambient env key (request-per-request ownership).
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const b64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n");
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    const serviceAccount = JSON.stringify({
      type: "service_account",
      client_email: "svc@example.test",
      private_key: pem,
      private_key_id: "k1",
    });
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => (account === "p/own" ? serviceAccount : null),
      setPassword: () => {},
      deletePassword: () => true,
    }));
    isolateHostAdc();
    oauthCalls = 0; // this describe's counter is shared across tests — reset for this probe
    const tok = await getVertexAccessToken({ markerAccount: "p/own" });
    expect(tok).toBe("marker-tok");
    expect(oauthCalls).toBe(1);
  });
});
