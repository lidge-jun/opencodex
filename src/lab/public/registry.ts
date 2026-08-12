import { domainHash, jcsStringify } from "../digest";
import type {
  PublicAdapterFamilyV1,
  PublicRouteRegistryEntryV1,
  PublicRouteRegistryManifestV1,
} from "./types";
import { PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION } from "./types";

const REGISTRY_DOMAIN = "ocx-lab:public-route-registry:v1";

const entries: PublicRouteRegistryEntryV1[] = [
  { providerId: "openai-apikey", modelId: "gpt-5.5", adapterFamilies: ["openai-responses"] },
  { providerId: "openai-apikey", modelId: "gpt-5.6-luna", adapterFamilies: ["openai-responses"] },
  { providerId: "openai-apikey", modelId: "gpt-5.6-sol", adapterFamilies: ["openai-responses"] },
  { providerId: "openai-apikey", modelId: "gpt-5.6-terra", adapterFamilies: ["openai-responses"] },
];

const manifestPayload = {
  schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  registryVersion: "2026-08-12.1",
  sourceCommit: "4fed8d3fe431ad23be83f3aff2af18ef8b8ecd71",
  entries,
};

export const PUBLIC_ROUTE_REGISTRY_V1: PublicRouteRegistryManifestV1 = Object.freeze({
  ...manifestPayload,
  entries: Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    adapterFamilies: Object.freeze([...entry.adapterFamilies]) as unknown as PublicAdapterFamilyV1[],
  }))) as unknown as PublicRouteRegistryEntryV1[],
  manifestDigest: domainHash(REGISTRY_DOMAIN, jcsStringify(manifestPayload)),
});

export function publicRouteRegistryDigest(
  manifest: Omit<PublicRouteRegistryManifestV1, "manifestDigest">,
): string {
  return domainHash(REGISTRY_DOMAIN, jcsStringify(manifest));
}

export function findPublicRouteRegistryEntry(
  providerId: string,
  modelId: string,
  adapterFamily: PublicAdapterFamilyV1,
  manifest: PublicRouteRegistryManifestV1 = PUBLIC_ROUTE_REGISTRY_V1,
): PublicRouteRegistryEntryV1 | null {
  return manifest.entries.find((entry) =>
    entry.providerId === providerId
    && entry.modelId === modelId
    && entry.adapterFamilies.includes(adapterFamily)) ?? null;
}
