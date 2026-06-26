import { describe, expect, test } from "bun:test";
import { buildInitProviders } from "../src/init";
import { isOAuthProvider, listOAuthProviders } from "../src/oauth/index";
import { deriveProviderPresets } from "../src/providers/derive";

// WP16 (devlog 350.100): the disabled OAuth shell was replaced by the real PKCE flow — the flow
// itself is covered by tests/cursor-oauth.test.ts. These tests cover cursor's provider-routing,
// init/preset metadata, and the OAuth module's standalone property (no local fs/process/http2).
describe("Cursor provider routing + standalone OAuth module", () => {
  // NOTE: flips to true in WP17 when cursor is registered in OAUTH_PROVIDERS.
  test("cursor is not exposed through OAuth provider routing yet", () => {
    expect(isOAuthProvider("cursor")).toBe(false);
    expect(listOAuthProviders()).not.toContain("cursor");
  });

  test("cursor is exposed through init and dashboard preset as an experimental local provider", () => {
    const cursor = buildInitProviders().find(provider => provider.id === "cursor");

    expect(cursor).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      kind: "local",
      defaultModel: "auto",
    });
    expect(cursor?.label.toLowerCase()).toContain("experimental");
    expect(deriveProviderPresets().find(preset => preset.id === "cursor")).toMatchObject({
      id: "cursor",
      adapter: "cursor",
      auth: "local",
      defaultModel: "auto",
    });
  });

  test("OAuth module stays standalone — no local fs/process/http2 (network only via fetch)", async () => {
    const source = await Bun.file("src/oauth/cursor.ts").text();

    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:http2");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("spawn(");
    expect(source).not.toContain("exec(");
  });
});
