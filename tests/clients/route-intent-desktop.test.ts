import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig, readConfigDiagnostics, loadConfig } from "../../src/config";
import { withClientLifecycleSync, type ClientLifecycleHeld } from "../../src/client/lifecycle-lock";
import { serviceApiTokenFingerprint, writeServiceApiTokenFile, replaceServiceApiTokenFile } from "../../src/lib/service-secrets";
import { applyRemoteDesktopStore, replaceRemoteDesktopCredential, restoreRemoteDesktopStore } from "../../src/claude/desktop-remote-store";
import type { OcxConfig } from "../../src/types";

let root: string;
let previous: Record<string, string | undefined>;
const token = "ocx_data_route_intent_fixture";
const owner = { serverUrl: "http://127.0.0.1:22001", apiKeyId: "fixture-key", connectedAt: "2026-11-07T00:00:00.000Z" };
function locked<T>(work: (held: ClientLifecycleHeld) => T): T { return withClientLifecycleSync(work, { lockPath: join(root, "lifecycle.sqlite") }); }
function config(): OcxConfig {
  return { port: 18274, hostname: "127.0.0.1", defaultProvider: "test", providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, runtimeRole: "client", client: {
    ...owner, transport: "link", link: { tunnelPort: 22001, linkId: "lnk_0123456789abcdef" },
    managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: ["claude-desktop"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1,
  } } as OcxConfig;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-route-desktop-"));
  previous = Object.fromEntries(["OPENCODEX_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"].map(key => [key, process.env[key]]));
  process.env.OPENCODEX_HOME = join(root, "ocx"); process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  saveConfig(config()); writeServiceApiTokenFile(token);
  expect(readConfigDiagnostics().source).toBe("file");
  expect(loadConfig().client?.link?.linkId).toBe("lnk_0123456789abcdef");
  mkdirSync(join(root, "desktop"));
  writeFileSync(join(root, "desktop", "_meta.json"), JSON.stringify({ entries: [], custom: "keep" }));
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});
function apply(baseUrl = "http://127.0.0.1:18274", apiKey = "opencodex-loopback") {
  return locked(held => applyRemoteDesktopStore(held, { owner, expectedTokenFingerprint: serviceApiTokenFingerprint(token),
    baseUrl, apiKey, mode: "static", models: [{ name: "claude-sonnet-4-6-20260217", labelOverride: "Local", anthropicFamilyTier: "sonnet" }],
    localListener: true,
  }));
}
test("Child Desktop uses its own port and placeholder, then preserves unrelated edits on restore", () => {
  const applied = apply(); expect(applied).toMatchObject({ ok: true });
  if (!applied.ok || !applied.path) throw new Error("missing applied path");
  const value = JSON.parse(readFileSync(applied.path, "utf8"));
  expect(value.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:18274");
  expect(value.inferenceGatewayApiKey).toBe("opencodex-loopback");
  expect(readFileSync(applied.path, "utf8")).not.toContain(token);
  value.unrelated = "survive"; writeFileSync(applied.path, JSON.stringify(value));
  const restored = locked(held => restoreRemoteDesktopStore(held, { owner, knownTokenFingerprints: [serviceApiTokenFingerprint(token)] }));
  expect(restored.ok).toBe(true);
  expect(JSON.parse(readFileSync(applied.path, "utf8"))).toEqual({ unrelated: "survive" });
});
test("local listener permission rejects another port, host, key, and non-Link connection", () => {
  expect(apply("http://127.0.0.1:18275").ok).toBe(false);
  expect(apply("https://foreign.example.test").ok).toBe(false);
  expect(apply("http://127.0.0.1:18274", token).ok).toBe(false);
  const hub = config(); delete hub.client!.link; delete hub.client!.transport; saveConfig(hub);
  expect(apply().ok).toBe(false);
});
test("service key rotation updates ownership without replacing the loopback placeholder", () => {
  const applied = apply(); expect(applied).toMatchObject({ ok: true });
  if (!applied.ok || !applied.path) throw new Error("missing applied path");
  const replacement = "ocx_data_route_intent_replacement";
  replaceServiceApiTokenFile(replacement);
  const next = config(); next.client!.tokenFingerprint = serviceApiTokenFingerprint(replacement); saveConfig(next);
  const rotated = locked(held => replaceRemoteDesktopCredential(held, { owner, expectedTokenFingerprint: serviceApiTokenFingerprint(token), replacementKey: replacement }));
  expect(rotated.ok).toBe(true);
  expect(JSON.parse(readFileSync(applied.path, "utf8")).inferenceGatewayApiKey).toBe("opencodex-loopback");
  expect(readFileSync(applied.path, "utf8")).not.toContain(replacement);
});
