import type { OcxProviderConfig } from "../types";

export const AZURE_IDENTITY_SCOPE = "https://cognitiveservices.azure.com/.default";
export const AZURE_IDENTITY_UNAVAILABLE_ERROR = "Azure identity credential unavailable";

export interface AzureTokenCredential {
  getToken(scope: string): Promise<{ token?: string } | null>;
}

export type AzureCredentialFactory = (options?: { managedIdentityClientId?: string }) =>
  AzureTokenCredential | Promise<AzureTokenCredential>;
export type AzureIdentityModuleLoader = () => Promise<{
  DefaultAzureCredential: new (options?: { managedIdentityClientId?: string }) => AzureTokenCredential;
}>;
export type AzureLoggerModuleLoader = () => Promise<{
  AzureLogger: { log: (...args: unknown[]) => void };
}>;

const credentials = new Map<string, AzureTokenCredential>();
const inflight = new Map<string, Promise<AzureTokenCredential>>();
let testFactory: AzureCredentialFactory | undefined;
let testModuleLoader: AzureIdentityModuleLoader | undefined;
let testLoggerModuleLoader: AzureLoggerModuleLoader | undefined;

async function loadAzureLoggerModule(): Promise<{
  AzureLogger: { log: (...args: unknown[]) => void };
}> {
  const packageName: string = "@azure/logger";
  return await import(packageName) as unknown as {
    AzureLogger: { log: (...args: unknown[]) => void };
  };
}

async function suppressAzureSdkLogging(): Promise<void> {
  const module = await (testLoggerModuleLoader ?? loadAzureLoggerModule)();
  module.AzureLogger.log = () => {};
}

async function loadAzureIdentityModule(): Promise<{
  DefaultAzureCredential: new (options?: { managedIdentityClientId?: string }) => AzureTokenCredential;
}> {
  // Keep the package out of the static module graph until Task 3 installs it.
  const packageName: string = "@azure/identity";
  return await import(packageName) as unknown as {
    DefaultAzureCredential: new (options?: { managedIdentityClientId?: string }) => AzureTokenCredential;
  };
}

async function loadDefaultAzureCredential(options?: { managedIdentityClientId?: string }): Promise<AzureTokenCredential> {
  await suppressAzureSdkLogging();
  const module = await (testModuleLoader ?? loadAzureIdentityModule)();
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
  const generation = cacheGeneration;
  let promise!: Promise<AzureTokenCredential>;
  promise = Promise.resolve((testFactory ?? loadDefaultAzureCredential)(clientId ? { managedIdentityClientId: clientId } : undefined))
    .then(credential => {
      if (cacheGeneration === generation) credentials.set(clientId, credential);
      return credential;
    })
    .finally(() => {
      if (inflight.get(clientId) === promise) inflight.delete(clientId);
    });
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
  cacheGeneration++;
  testFactory = factory;
  testModuleLoader = undefined;
  testLoggerModuleLoader = undefined;
  credentials.clear();
  inflight.clear();
}

export function __resetAzureCredentialCache(): void {
  cacheGeneration++;
  testFactory = undefined;
  testModuleLoader = undefined;
  testLoggerModuleLoader = undefined;
  credentials.clear();
  inflight.clear();
}

let cacheGeneration = 0;

export function setAzureIdentityModuleLoaderForTests(loader: AzureIdentityModuleLoader): void {
  cacheGeneration++;
  testFactory = undefined;
  testModuleLoader = loader;
  credentials.clear();
  inflight.clear();
}

export function setAzureLoggerModuleLoaderForTests(loader: AzureLoggerModuleLoader): void {
  testLoggerModuleLoader = loader;
}
