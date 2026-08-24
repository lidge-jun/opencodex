import type { OcxProviderConfig } from "../types";

export const AZURE_IDENTITY_SCOPE = "https://cognitiveservices.azure.com/.default";
export const AZURE_IDENTITY_UNAVAILABLE_ERROR = "Azure identity credential unavailable";

export interface AzureTokenCredential {
  getToken(scope: string): Promise<{ token?: string } | null>;
}

export type AzureCredentialFactory = (options?: { managedIdentityClientId?: string }) =>
  AzureTokenCredential | Promise<AzureTokenCredential>;

const credentials = new Map<string, AzureTokenCredential>();
const inflight = new Map<string, Promise<AzureTokenCredential>>();
let testFactory: AzureCredentialFactory | undefined;

async function loadDefaultAzureCredential(options?: { managedIdentityClientId?: string }): Promise<AzureTokenCredential> {
  // Keep the package out of the static module graph until Task 3 installs it.
  const packageName: string = "@azure/identity";
  const module = await import(packageName) as unknown as {
    DefaultAzureCredential: new (options?: { managedIdentityClientId?: string }) => AzureTokenCredential;
  };
  return options === undefined
    ? new module.DefaultAzureCredential()
    : new module.DefaultAzureCredential(options);
}

function clientIdFor(provider: OcxProviderConfig): string {
  return provider.azureCredential?.managedIdentityClientId?.trim() ?? "";
}

async function credentialFor(clientId: string): Promise<AzureTokenCredential> {
  const cached = credentials.get(clientId);
  if (cached) return cached;
  const running = inflight.get(clientId);
  if (running) return running;
  const promise = Promise.resolve((testFactory ?? loadDefaultAzureCredential)(clientId ? { managedIdentityClientId: clientId } : undefined))
    .then(credential => {
      credentials.set(clientId, credential);
      return credential;
    })
    .finally(() => inflight.delete(clientId));
  inflight.set(clientId, promise);
  return promise;
}

export async function getAzureAccessToken(provider: OcxProviderConfig): Promise<string> {
  try {
    const credential = await credentialFor(clientIdFor(provider));
    const result = await credential.getToken(AZURE_IDENTITY_SCOPE);
    const token = result?.token?.trim();
    if (!token) throw new Error(AZURE_IDENTITY_UNAVAILABLE_ERROR);
    return token;
  } catch {
    throw new Error(AZURE_IDENTITY_UNAVAILABLE_ERROR);
  }
}

export function setAzureCredentialFactoryForTests(factory: AzureCredentialFactory): void {
  testFactory = factory;
  credentials.clear();
  inflight.clear();
}

export function __resetAzureCredentialCache(): void {
  testFactory = undefined;
  credentials.clear();
  inflight.clear();
}
