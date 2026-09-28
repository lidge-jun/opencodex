import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeRoutingVerifier, matchesNativeCompatibilityRouting } from "../../src/codex/desktop-compatibility/routing-preflight";
import { bindNativeCompatibilityOwner, nativeCompatibilityOwner, type NativeCompatibilityOwner } from "../../src/codex/desktop-compatibility/routing-binding";
import { removeTreeWithRetry } from "../helpers/remove-tree";
const owner: NativeCompatibilityOwner = { hostname: "127.0.0.1", port: 12001, loopbackPort: 12002, config: { port: 10100, providers: {} } };
const text = 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:12001/v1"\n';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

test("address family matches the bound listener instead of any loopback alias", () => {
  const ipv6 = text.replace("127.0.0.1", "[::1]");
  expect(matchesNativeCompatibilityRouting(ipv6, owner)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text.replace("127.0.0.1", "localhost"), owner)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text, { ...owner, hostname: "0.0.0.0" })).toBe(true);
  expect(matchesNativeCompatibilityRouting(text, { ...owner, hostname: "192.0.2.10" })).toBe(false);
  const v6Owner = { ...owner, hostname: "::1" };
  expect(matchesNativeCompatibilityRouting(ipv6, v6Owner)).toBe(true);
  expect(matchesNativeCompatibilityRouting(text, v6Owner)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text.replace(":12001", ":12002"), v6Owner)).toBe(true);
  expect(matchesNativeCompatibilityRouting(ipv6.replace(":12001", ":12002"), v6Owner)).toBe(false);
  // Mutable desired config does not replace the socket's captured address.
  expect(matchesNativeCompatibilityRouting(ipv6, { ...owner, config: { ...owner.config, hostname: "::1" } })).toBe(false);
});

test("changing the actual listener identity revokes a prior observation", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-listener-change-")); roots.push(root);
  writeFileSync(join(root, "config.toml"), text);
  const live = { ...owner }, verify = createNativeRoutingVerifier(root, () => live);
  expect(verify()).toBe(true);
  live.hostname = "0.0.0.0";
  expect(matchesNativeCompatibilityRouting(text, live)).toBe(true);
  expect(verify()).toBe(false);
});
test("the actual bound listener and companion port are accepted, not a stale configured port", () => {
  expect(matchesNativeCompatibilityRouting(text, owner)).toBe(true);
  expect(matchesNativeCompatibilityRouting(text.replace(":12001", ":12002"), owner)).toBe(true);
  expect(matchesNativeCompatibilityRouting(text.replace(":12001", ":10100"), owner)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text, null)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text, { ...owner, config: { ...owner.config, codexDesktopAuthless: true } })).toBe(false);
  expect(matchesNativeCompatibilityRouting(text, { ...owner, config: { ...owner.config, runtimeRole: "client" } })).toBe(false);
});
test("foreign providers, destinations, credentials and unknown profiles cannot qualify", () => {
  for (const candidate of [text.replace('"openai"', '"custom"'), text.replace("127.0.0.1", "example.test"),
    text.replace("http://", "https://"), text.replace("127.0.0.1", "user:pass@127.0.0.1"), text.replace("/v1", "/v1?x=1"),
    text + 'profile = "missing"', 'invalid toml [', text + 'forced_login_method = "api"']) {
    expect(matchesNativeCompatibilityRouting(candidate, owner)).toBe(false);
  }
  expect(matchesNativeCompatibilityRouting(text + 'profile = "work"\n[profiles.work]\nmodel_provider = "custom"', owner)).toBe(false);
  expect(matchesNativeCompatibilityRouting(text + 'profile = "work"\n[profiles.work]\nmodel_provider = "openai"', owner)).toBe(true);
});
test("read-only verifier rereads changed config and owner detach cannot clear a newer owner", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-routing-")); roots.push(root);
  const path = join(root, "config.toml"); writeFileSync(path, text);
  const detach = bindNativeCompatibilityOwner(owner), second = { ...owner };
  const detachSecond = bindNativeCompatibilityOwner(second); detach(); expect(nativeCompatibilityOwner()).toBe(second);
  try {
    const verify = createNativeRoutingVerifier(root); expect(verify()).toBe(true);
    writeFileSync(path, text.replace(":12001", ":13000")); expect(verify()).toBe(false);
  } finally { detachSecond(); }
  expect(nativeCompatibilityOwner()).toBeNull();
});

test("model and fallback edits revoke routing until a new observation context is created", () => {
  const changes = [
    { defaultProvider: "openai" }, { subagentModelFallback: ["openai/gpt-6-luna"] },
    { subagentModelFallbackByModel: { "external/model": ["openai/gpt-6-luna"] } },
    { compactionRecovery: { enabled: true, model: "openai/gpt-6-luna" } },
    { blockedModelRedirects: { "external/model": "openai/gpt-6-luna" } },
    { providers: { external: { baseUrl: "https://changed.example.test/v1" } } },
    { combos: {} }, { routingProfiles: {} },
    { memoryModels: { extract: { model: "openai/gpt-6-luna" } } },
  ];
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-route-change-")); roots.push(root);
  writeFileSync(join(root, "config.toml"), text);
  for (const change of changes) {
    const live = { ...owner, config: { ...owner.config } };
    const verify = createNativeRoutingVerifier(root, () => live); expect(verify()).toBe(true);
    Object.assign(live.config, change); expect(verify()).toBe(false);
    live.config = { ...owner.config }; expect(verify()).toBe(false);
    expect(createNativeRoutingVerifier(root, () => live)()).toBe(true);
  }
});

test("root model edits revoke context but unrelated preference and object order do not", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-route-baseline-")); roots.push(root);
  const path = join(root, "config.toml"); writeFileSync(path, text);
  const live = { ...owner, config: { ...owner.config, blockedModelRedirects: { a: "external/a", b: "external/b" } } };
  const verify = createNativeRoutingVerifier(root, () => live); expect(verify()).toBe(true);
  live.config.blockedModelRedirects = { b: "external/b", a: "external/a" };
  Object.assign(live.config, { desktopCompatibility: { startOnProxyStart: true } }); expect(verify()).toBe(true);
  writeFileSync(path, text + 'model = "external/other"\n'); expect(verify()).toBe(false);
  writeFileSync(path, text); expect(verify()).toBe(false);
});

test("desktop MCP rewrites and TOML formatting preserve the observation while model edits still revoke it", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-desktop-mcp-refresh-")); roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, text + 'model = "external/model"\n[mcp_servers.desktop]\nurl = "http://127.0.0.1:21001/mcp"\n');
  const verify = createNativeRoutingVerifier(root, () => owner);
  expect(verify()).toBe(true);
  const rewritten = '# Desktop rewrites its MCP endpoint after launch.\n' + text
    + 'model = "external/model"\n[mcp_servers.desktop]\nurl = "http://127.0.0.1:21002/mcp"\n';
  writeFileSync(path, rewritten); expect(verify()).toBe(true);
  writeFileSync(path, text + 'model = "external/model"\n'); expect(verify()).toBe(true);
  writeFileSync(path, rewritten.replace('model = "external/model"', 'model = "openai/model"'));
  expect(verify()).toBe(false);
  writeFileSync(path, rewritten); expect(verify()).toBe(false);
});
