import { afterEach, describe, expect, test } from "bun:test";
import {
  AZURE_IDENTITY_UNAVAILABLE_ERROR,
  __resetAzureCredentialCache,
  getAzureAccessToken,
  setAzureCredentialFactoryForTests,
} from "../src/lib/azure-identity";
import type { OcxProviderConfig } from "../src/types";

afterEach(() => {
  __resetAzureCredentialCache();
});

function provider(clientId?: string): OcxProviderConfig {
  return {
    adapter: "azure-openai",
    baseUrl: "https://resource.openai.azure.com/openai",
    azureCredential: {
      type: "default-azure-credential",
      ...(clientId === undefined ? {} : { managedIdentityClientId: clientId }),
    },
  };
}

describe("Azure identity credential helper", () => {
  test("caches credentials by normalized managed-identity client id and uses the exact scope", async () => {
    let constructed = 0;
    const scopes: string[] = [];
    const clientIds: Array<string | undefined> = [];
    setAzureCredentialFactoryForTests(options => {
      constructed++;
      clientIds.push(options?.managedIdentityClientId);
      return { getToken: async (scope: string) => { scopes.push(scope); return { token: `token-${constructed}` }; } };
    });

    expect(await getAzureAccessToken(provider("  client-123  "))).toBe("token-1");
    expect(await getAzureAccessToken(provider("client-123"))).toBe("token-1");
    expect(await getAzureAccessToken(provider("client-456"))).toBe("token-2");
    expect(constructed).toBe(2);
    expect(clientIds).toEqual(["client-123", "client-456"]);
    expect(scopes).toEqual([
      "https://cognitiveservices.azure.com/.default",
      "https://cognitiveservices.azure.com/.default",
      "https://cognitiveservices.azure.com/.default",
    ]);
  });

  test("redacts SDK failures and blank tokens behind one stable error", async () => {
    setAzureCredentialFactoryForTests(() => ({
      getToken: async () => { throw new Error("AggregateAuthenticationError tenant-secret token-secret"); },
    }));
    await expect(getAzureAccessToken(provider())).rejects.toThrow(AZURE_IDENTITY_UNAVAILABLE_ERROR);
    await expect(getAzureAccessToken(provider())).rejects.not.toThrow("tenant-secret");

    __resetAzureCredentialCache();
    setAzureCredentialFactoryForTests(() => ({ getToken: async () => ({ token: "   " }) }));
    await expect(getAzureAccessToken(provider())).rejects.toThrow(AZURE_IDENTITY_UNAVAILABLE_ERROR);
  });

  test("uses the default credential constructor shape when no client id is configured", async () => {
    let options: { managedIdentityClientId?: string } | undefined = { managedIdentityClientId: "unexpected" };
    setAzureCredentialFactoryForTests(received => {
      options = received;
      return { getToken: async () => ({ token: "default-token" }) };
    });
    expect(await getAzureAccessToken(provider())).toBe("default-token");
    expect(options).toBeUndefined();
  });
});
