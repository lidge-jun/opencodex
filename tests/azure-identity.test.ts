import { afterEach, describe, expect, test } from "bun:test";
import {
  AZURE_IDENTITY_UNAVAILABLE_ERROR,
  __resetAzureCredentialCache,
  getAzureAccessToken,
  setAzureCredentialFactoryForTests,
  setAzureLoggerModuleLoaderForTests,
  setAzureIdentityModuleLoaderForTests,
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

  test("reset does not let an older in-flight construction repopulate the cache", async () => {
    let releaseOld!: (credential: { getToken: (scope: string) => Promise<{ token: string }> }) => void;
    let constructions = 0;
    setAzureCredentialFactoryForTests(() => {
      constructions++;
      if (constructions === 1) {
        return new Promise(resolve => { releaseOld = resolve; });
      }
      return { getToken: async () => ({ token: "new-token" }) };
    });
    const oldRequest = getAzureAccessToken(provider("client")).catch(() => "old-failed");
    await Bun.sleep(0);
    __resetAzureCredentialCache();
    setAzureCredentialFactoryForTests(() => ({ getToken: async () => ({ token: "new-token" }) }));
    expect(await getAzureAccessToken(provider("client"))).toBe("new-token");
    releaseOld({ getToken: async () => ({ token: "old-token" }) });
    await oldRequest;
    expect(await getAzureAccessToken(provider("client"))).toBe("new-token");
  });

  test("dynamic module-loader failures are stable and redacted", async () => {
    setAzureIdentityModuleLoaderForTests(async () => {
      throw new Error("Cannot find module @azure/identity tenant-secret token-secret");
    });
    const error = await getAzureAccessToken(provider()).catch(value => value as Error);
    expect(error.message).toBe(AZURE_IDENTITY_UNAVAILABLE_ERROR);
    expect(error.message).not.toContain("tenant-secret");
    expect(error.message).not.toContain("@azure/identity");
  });

  test("suppresses Azure SDK diagnostics before constructing the credential chain", async () => {
    const previousAzureLogLevel = process.env.AZURE_LOG_LEVEL;
    const previousDebug = process.env.DEBUG;
    const emitted: string[] = [];
    const logger = {
      log: (...args: unknown[]) => emitted.push(args.map(String).join(" ")),
    };
    process.env.AZURE_LOG_LEVEL = "info";
    process.env.DEBUG = "azure:*";
    setAzureLoggerModuleLoaderForTests(async () => ({ AzureLogger: logger }));
    setAzureIdentityModuleLoaderForTests(async () => ({
      DefaultAzureCredential: class {
        constructor() {
          logger.log("azure:identity diagnostic synthetic-client-id");
        }
        getToken = async () => ({ token: "synthetic-token" });
      },
    }));
    try {
      await expect(getAzureAccessToken(provider())).resolves.toBe("synthetic-token");
      expect(emitted).toEqual([]);
    } finally {
      if (previousAzureLogLevel === undefined) delete process.env.AZURE_LOG_LEVEL;
      else process.env.AZURE_LOG_LEVEL = previousAzureLogLevel;
      if (previousDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previousDebug;
    }
  });
});
