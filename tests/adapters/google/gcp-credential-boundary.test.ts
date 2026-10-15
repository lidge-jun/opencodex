import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../../src/config";
import * as configModule from "../../../src/config";
import { __resetVertexTokenCache, getVertexAccessToken } from "../../../src/lib/gcp-adc";
import { addProviderApiKey, listProviderApiKeys, providerCredentialInputError, splitCredentialPaste } from "../../../src/providers/api-keys";
import { clearKeyCooldowns, rotateProviderTransportOn401, rotateProviderTransportOn429 } from "../../../src/providers/key-failover";
import { restoreProviderKeyFromKeychain, setProviderKeychainEntryFactoryForTests } from "../../../src/providers/key-store";
import { routedProviderConfig } from "../../../src/router";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { providerEditorConfigDTO, safeConfigDTO } from "../../../src/server/auth-cors";
import { resolveProviderApiKey, resolveProviderApiKeyQuietly } from "../../../src/providers/api-key-resolve";
import { handleProviderCommand } from "../../../src/cli/provider";
import { handleProviderRoutes } from "../../../src/server/management/provider-routes";
import type { OcxConfig, OcxParsedRequest } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const credential = JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" });
const encodedCredential = credential.replace(/[A-Za-z_]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
const rejectedInputs = [
  `[${credential}]`,
  JSON.stringify(credential),
  JSON.stringify(encodedCredential),
  JSON.stringify([encodedCredential]),
  JSON.stringify({ credentials: encodedCredential }),
  '{"type":"service_account","private_key":"fixture-key",}',
  "{'type':'authorized_user','client_secret':'fixture-secret','refresh_token':'fixture-refresh'}",
];
let home: string;
let previousHome: string | undefined;
let config: OcxConfig;
const secrets = new Map<string, string>();

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-gcp-boundary-"));
  process.env.OPENCODEX_HOME = home;
  config = { port: 10199, defaultProvider: "vertex", providers: {
    vertex: { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "fixture-project", location: "global", apiKey: "fixture-key" },
  } };
  saveConfig(config);
  secrets.clear();
  setProviderKeychainEntryFactoryForTests((_service, account) => ({
    getPassword: () => secrets.get(account) ?? null,
    setPassword: value => { secrets.set(account, value); },
    deletePassword: () => secrets.delete(account),
  }));
  __resetVertexTokenCache();
  clearKeyCooldowns();
});

afterEach(() => {
  mock.restore();
  __resetVertexTokenCache();
  clearKeyCooldowns();
  setProviderKeychainEntryFactoryForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test.each([resolveProviderApiKey, resolveProviderApiKeyQuietly])("keychain aliases refuse GCP payloads before wire-key resolution %#", resolve => {
  for (const input of [credential, encodedCredential, ...rejectedInputs]) {
    secrets.set("vertex/fixture", input);
    expect(() => resolve("keychain:vertex/fixture")).toThrow(/gcp-sa reference/);
    config.providers.vertex!.apiKey = "keychain:vertex/fixture";
    expect(() => routedProviderConfig("vertex", config.providers.vertex!)).toThrow(/gcp-sa reference/);
  }
});

test.each(["cli", "management"])("%s deletion includes a credential added immediately before save-lock acquisition", async surface => {
  config.providers.other = { adapter: "openai-chat", baseUrl: "https://other.example/v1" };
  config.defaultProvider = "other";
  saveConfig(config);
  expect(addProviderApiKey(config, "vertex", credential)).toHaveProperty("id");
  const lock = configModule.withConfigMutationLockSync;
  let wrote = false;
  spyOn(configModule, "withConfigMutationLockSync").mockImplementation(<T>(fn: () => T, dir?: string): T => {
    if (!wrote) {
      wrote = true;
      const fresh = loadConfig();
      expect(addProviderApiKey(fresh, "vertex", JSON.stringify({ ...JSON.parse(credential), client_id: "late-fixture" }))).toHaveProperty("id");
    }
    return lock(fn, dir);
  });
  spyOn(console, "log").mockImplementation(() => {});
  if (surface === "cli") await handleProviderCommand(["remove", "vertex", "--json"]);
  else {
    const url = new URL("http://127.0.0.1/api/providers?name=vertex");
    const response = await handleProviderRoutes({ req: new Request(url, { method: "DELETE" }), url, config,
      deps: {}, version: "test", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    expect(response?.status).toBe(200);
  }
  expect(wrote).toBe(true);
  expect(loadConfig().providers.vertex).toBeUndefined();
  expect(secrets.size).toBe(0);
});

test.each(rejectedInputs)("wrapped/malformed credential paste is refused before persistence %#", input => {
  const before = readFileSync(join(home, "config.json"), "utf8");
  expect(() => splitCredentialPaste(input)).toThrow();
  expect(providerCredentialInputError({ apiKey: input })).toBeDefined();
  expect(providerCredentialInputError({ apiKeyPool: [{ id: "fixture", key: input }] })).toBeDefined();
  expect(addProviderApiKey(config, "vertex", input)).toHaveProperty("error");
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(secrets.size).toBe(0);
});

test.each([...rejectedInputs, encodedCredential])("keychain restore refuses credential-shaped payload %#", input => {
  config.providers.vertex!.apiKey = "keychain:vertex";
  saveConfig(config);
  secrets.set("vertex", input);
  expect(restoreProviderKeyFromKeychain(config, "vertex")).toMatchObject({ ok: false });
  expect(loadConfig().providers.vertex!.apiKey).toBe("keychain:vertex");
  expect(secrets.get("vertex")).toBe(input);
});

test("removing a stored marker payload invalidates its cached token without an ambient fallback", async () => {
  secrets.set("vertex/fixture", credential);
  let exchanges = 0;
  const fetchImpl = (async () => {
    exchanges += 1;
    return Response.json({ access_token: "fixture-access", expires_in: 3600 });
  }) as typeof fetch;
  expect(await getVertexAccessToken({ markerAccount: "vertex/fixture", fetch: fetchImpl })).toBe("fixture-access");
  secrets.delete("vertex/fixture");
  await expect(getVertexAccessToken({ markerAccount: "vertex/fixture", fetch: fetchImpl })).rejects.toThrow();
  expect(exchanges).toBe(1);
});

test.each([401, 429])("mixed service-account and literal pool preserves wire identity on %i rotation", async status => {
  const keyPair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----`;
  const json = JSON.stringify({ type: "service_account", client_email: "fixture@example.test", private_key: pem });
  expect(addProviderApiKey(config, "vertex", json)).toHaveProperty("id");
  const parsed = { modelId: "gemini-fixture", context: { messages: [{ role: "user", content: "fixture" }], systemPrompt: [], tools: [] }, options: {}, stream: false } as OcxParsedRequest;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ access_token: "fixture-access", expires_in: 3600 })) as typeof fetch;
  try {
    const active = routedProviderConfig("vertex", config.providers.vertex!);
    const bearer = await createGoogleAdapter(active).buildRequest(parsed);
    expect(bearer.headers.Authorization).toBe("Bearer fixture-access");
    expect(bearer.headers["x-goog-api-key"]).toBeUndefined();
    const rotate = status === 401 ? rotateProviderTransportOn401 : rotateProviderTransportOn429;
    const literal = rotate(config, "vertex", active, { attemptedKey: active.apiKey });
    expect(literal?.apiKey).toBe("fixture-key");
    const keyRequest = await createGoogleAdapter(literal!).buildRequest(parsed);
    expect(keyRequest.headers["x-goog-api-key"]).toBe("fixture-key");
    expect(keyRequest.headers.Authorization).toBeUndefined();
    clearKeyCooldowns();
    const marker = rotate(config, "vertex", literal!, { attemptedKey: literal!.apiKey });
    expect(marker?.apiKey).toStartWith("gcp-sa:");
    const back = await createGoogleAdapter(marker!).buildRequest(parsed);
    expect(back.headers.Authorization).toBe("Bearer fixture-access");
    expect(back.headers["x-goog-api-key"]).toBeUndefined();
    const dto = JSON.stringify([safeConfigDTO(config), providerEditorConfigDTO(config), listProviderApiKeys(config, "vertex")]);
    for (const secret of [pem, "PRIVATE KEY", "fixture@example.test", "fixture-access", "fixture-key"]) expect(dto).not.toContain(secret);
  } finally { globalThis.fetch = oldFetch; }
});
