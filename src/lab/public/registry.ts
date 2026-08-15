import { publicEvidenceId } from "./ids";
import {
  PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  type PublicAdapterFamily,
  type PublicRouteRegistryEntryV1,
  type PublicRouteRegistryManifestV1,
} from "./types";

// Repository-authoritative provider/model/adapter snapshot. The public manifest
// itself is independently content-addressed by manifestDigest below.
const PUBLIC_ROUTE_REGISTRY_SOURCE_COMMIT = "75a21417657ba5a3033198be0d8ae949de723d11";

const entries: PublicRouteRegistryEntryV1[] = [
  {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    adapterFamilies: ["openai-responses"],
  },
];

const manifestWithoutDigest = {
  schemaVersion: PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  registryVersion: "2026-08-13.v2",
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
