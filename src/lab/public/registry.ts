import { publicEvidenceId } from "./ids";
import type {
  PublicAdapterFamily,
  PublicRouteRegistryEntryV1,
  PublicRouteRegistryManifestV1,
} from "./types";

const PUBLIC_ROUTE_REGISTRY_SOURCE_COMMIT = "fdc954a3ae721d6618e3bfb0cbd1a3163888b674";

const entries: PublicRouteRegistryEntryV1[] = [
  {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    adapterFamilies: ["openai-responses", "openai-chat"],
  },
];

const manifestWithoutDigest = {
  schemaVersion: "public_route_registry_v1" as const,
  registryVersion: "2026-08-12.v1",
  sourceCommit: PUBLIC_ROUTE_REGISTRY_SOURCE_COMMIT,
  entries,
};

export const PUBLIC_ROUTE_REGISTRY_V1: PublicRouteRegistryManifestV1 = Object.freeze({
  ...manifestWithoutDigest,
  entries: Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    adapterFamilies: Object.freeze([...entry.adapterFamilies]) as unknown as PublicAdapterFamily[],
  }))) as unknown as PublicRouteRegistryEntryV1[],
  manifestDigest: publicEvidenceId("route_registry", manifestWithoutDigest),
});

export function findPublicRouteRegistryEntry(
  providerId: string,
  modelId: string,
): PublicRouteRegistryEntryV1 | undefined {
  return PUBLIC_ROUTE_REGISTRY_V1.entries.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId,
  );
}
