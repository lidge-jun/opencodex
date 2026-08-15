import { expect, test } from "bun:test";
import { buildManualEnv } from "../src/pages/claude-manual-env";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "zh", "zh-TW"] as const;

async function read(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

const NEW_KEYS = [
  "claude.authModeAuto",
  "claude.effectiveMode.label",
  "claude.effectiveMode.manual",
  "claude.effectiveMode.autoPresent",
  "claude.effectiveMode.autoAbsent",
  "claude.effectiveMode.autoUnknown",
  "claude.effectiveMode.admissionKey",
  "claude.authSource.claude-json-oauth",
  "claude.authSource.claude-credentials-file",
  "claude.authSource.macos-keychain",
  "claude.authSource.exported-env",
  "claude.authSource.unknown",
];

test("every locale carries the auth-mode keys", async () => {
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const dict = await read(`../src/i18n/${locale}.ts`);
    for (const key of NEW_KEYS) {
      if (!dict.includes(`"${key}"`)) missing.push(`${locale}:${key}`);
    }
  }
  expect(missing).toEqual([]);
});

// The select must offer a way BACK to auto: without it, one save converts a user to a
// sticky manual mode forever (devlog 260726_claude_auth_auto/002 §3).
test("the auth-mode select offers auto first", async () => {
  const section = await read("../src/pages/claude-code-sections.tsx");
  const optionsBlock = section.slice(section.indexOf("claude.authMode\")"), section.indexOf("claude.effectiveMode.label"));
  expect(optionsBlock).toContain("claude.authModeAuto");
  expect(optionsBlock.indexOf("claude.authModeAuto")).toBeLessThan(optionsBlock.indexOf("claude.authModeSubscription"));
});

// The GUI must not re-introduce the coercion that killed auto on load.
test("the page maps an unknown authMode to auto, never to subscription", async () => {
  const page = await read("../src/pages/ClaudeCode.tsx");
  expect(page).toContain('r.authMode === "proxy" || r.authMode === "subscription" ? r.authMode : "auto"');
});

test("the reason line renders every origin plus the admission note", async () => {
  const section = await read("../src/pages/claude-code-sections.tsx");
  for (const key of ["effectiveMode.manual", "effectiveMode.autoPresent", "effectiveMode.autoAbsent", "effectiveMode.autoUnknown", "effectiveMode.admissionKey"]) {
    expect(section).toContain(key);
  }
});

// The manual snippet follows the daemon resolution under auto, and degrades to the
// historical default when an older proxy sends no markerMode.
test("the manual env snippet follows markerMode under auto", () => {
  const base = { maxContextTokens: null, autoContext: false, autoCompactWindow: null, effectiveModelEnv: {}, port: 10100 };

  const autoProxy = buildManualEnv({ ...base, authMode: "auto", markerMode: "proxy" });
  expect(autoProxy).toContain("export ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
  expect(autoProxy).toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1");

  const autoSubscription = buildManualEnv({ ...base, authMode: "auto", markerMode: "subscription" });
  expect(autoSubscription).not.toContain("ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
  expect(autoSubscription).not.toContain("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");

  // Older proxy: no markerMode -> historical subscription default, not a proxy guess.
  const degraded = buildManualEnv({ ...base, authMode: "auto" });
  expect(degraded).not.toContain("ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
});

test("an explicit manual mode still drives the snippet directly", () => {
  const base = { maxContextTokens: null, autoContext: false, autoCompactWindow: null, effectiveModelEnv: {}, port: 10100 };
  // markerMode is deliberately contradictory here: the explicit choice must win.
  expect(buildManualEnv({ ...base, authMode: "proxy", markerMode: "subscription" }))
    .toContain("export ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
  expect(buildManualEnv({ ...base, authMode: "subscription", markerMode: "proxy" }))
    .not.toContain("export ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
});
