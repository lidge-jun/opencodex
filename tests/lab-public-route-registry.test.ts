import { describe, expect, test } from "bun:test";
import { PUBLIC_ROUTE_REGISTRY_V1, validatePublicRouteRegistryManifest } from "../src/lab/public";

const REVIEWED_AUTHORITY_SOURCE_COMMIT = "75a21417657ba5a3033198be0d8ae949de723d11";

describe("CL-10 public route registry authority", () => {
  test("pins the reviewed OpenAI gpt-5.6-sol authority exactly", () => {
    const manifest = validatePublicRouteRegistryManifest(PUBLIC_ROUTE_REGISTRY_V1);

    expect(manifest.registryVersion).toBe("2026-08-13.v2");
    expect(manifest.sourceCommit).toBe(REVIEWED_AUTHORITY_SOURCE_COMMIT);
    expect(manifest.entries).toEqual([
      {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        adapterFamilies: ["openai-responses"],
      },
    ]);
  });
});
