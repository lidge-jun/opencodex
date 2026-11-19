import { expect, test } from "bun:test";
import { binProviderStatus, isFreeProvider } from "../src/provider-workspace/catalog";
import { providerAuthSurface } from "../src/provider-workspace/auth";
import { formatProviderDisplayName } from "../src/provider-icons";
import type { WorkspaceItem, WorkspaceProvider } from "../src/provider-workspace/catalog";

/**
 * The Antigravity ACP row (adapter `agy-acp`) drives the locally signed-in Antigravity CLI: it has
 * no key, so the configured row is ready, offers no key surface and is not priced as free, the
 * same as a Claude Code CLI row. The configured row carries no registry `keyOptional`, so the
 * adapter alone has to decide.
 */
const row = { name: "antigravity-acp", adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp", hasApiKey: false, models: ["gemini-3.8-flash"] } as unknown as WorkspaceProvider;

test("a configured Antigravity ACP row is ready without a key and is not free", () => {
  expect(binProviderStatus(row)).toBe("ready");
  expect(isFreeProvider(row)).toBe(false);
  expect(providerAuthSurface(row as unknown as WorkspaceItem)).toBeNull();
});

test("its display name keeps the brand casing", () => {
  expect(formatProviderDisplayName("antigravity-acp", (key: string) => key)).toBe("Antigravity CLI (ACP)");
});
