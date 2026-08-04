import { expect, test } from "bun:test";
import { buildClaudeEnv } from "../src/cli/claude";
import { PROXY_MARKER, type AuthDetectDeps, type AuthPresence } from "../src/claude/auth-detect";
import { authModeIntent, resolveClaudeAuthMode } from "../src/claude/auth-mode";
import { detectClaudeAuth } from "../src/claude/auth-detect";
import type { OcxConfig } from "../src/types";

/**
 * Auto is a RESOLUTION, not stored state: registering a Claude login changes the next
 * launch with no migration. A manual choice bypasses detection forever.
 */

function cfg(claudeCode?: OcxConfig["claudeCode"], apiKeys?: { key: string }[]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    ...(claudeCode ? { claudeCode } : {}),
    ...(apiKeys ? { apiKeys } : {}),
  } as unknown as OcxConfig;
}

function detection(presence: AuthPresence, staleProxyMarker = false) {
  const deps: AuthDetectDeps = {
    readClaudeJson: () => (presence === "present" ? { oauthAccount: { emailAddress: "user@example.com" } } : undefined),
    credentialsFileExists: () => false,
    keychainProbe: () => (presence === "unknown" ? "unknown" : "absent"),
    env: () => (staleProxyMarker ? { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER } : {}),
  };
  return detectClaudeAuth(deps);
}

// Detector stubs for buildClaudeEnv: file/keychain sources only, so the env source
// still reads the real launch base (which is the point of the binding).
function fileAuth(presence: AuthPresence): Omit<Partial<AuthDetectDeps>, "env"> {
  return {
    readClaudeJson: () => (presence === "present" ? { oauthAccount: { emailAddress: "user@example.com" } } : undefined),
    credentialsFileExists: () => false,
    keychainProbe: () => (presence === "unknown" ? "unknown" : "absent"),
  };
}

test("auto resolves subscription when auth is present and proxy when absent", () => {
  expect(resolveClaudeAuthMode(cfg(), detection("present")).markerMode).toBe("subscription");
  expect(resolveClaudeAuthMode(cfg(), detection("present")).origin).toBe("auto-present");
  expect(resolveClaudeAuthMode(cfg(), detection("absent")).markerMode).toBe("proxy");
  expect(resolveClaudeAuthMode(cfg(), detection("absent")).origin).toBe("auto-absent");
});

// The safety rule: a failed read must not move a subscriber onto proxy.
test("auto with unknown detection keeps subscription behaviour", () => {
  const resolved = resolveClaudeAuthMode(cfg(), detection("unknown"));
  expect(resolved.markerMode).toBe("subscription");
  expect(resolved.origin).toBe("auto-unknown");
});

test("a manual choice survives every auth flip unchanged", () => {
  for (const presence of ["present", "absent", "unknown"] as AuthPresence[]) {
    expect(resolveClaudeAuthMode(cfg({ authMode: "proxy" }), detection(presence)).markerMode).toBe("proxy");
    expect(resolveClaudeAuthMode(cfg({ authMode: "proxy" }), detection(presence)).origin).toBe("manual");
    expect(resolveClaudeAuthMode(cfg({ authMode: "subscription" }), detection(presence)).markerMode).toBe("subscription");
  }
});

test("intent reports auto for an unset key", () => {
  expect(authModeIntent(cfg())).toBe("auto");
  expect(authModeIntent(cfg({ authMode: "proxy" }))).toBe("proxy");
  expect(authModeIntent(cfg({ authMode: "subscription" }))).toBe("subscription");
});

test("auto-absent injects the marker; auto-present does not", () => {
  const absent = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(absent.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);

  const present = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(present.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

// THE feedback loop: a marker left by a previous launch must not read as auth, and
// must not survive into a subscription launch.
test("a stale marker is stripped when the mode resolves subscription", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  // And with no token there is no host-managed assertion (the #253 class).
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
});

test("a stale marker is re-established when the mode still resolves proxy", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
});

// The ordering blocker: a stale marker must not suppress the configured admission key.
test("a stale marker never suppresses the admission key", () => {
  const env = buildClaudeEnv(
    cfg(undefined, [{ key: "admission-key" }]), 10100,
    { ANTHROPIC_AUTH_TOKEN: PROXY_MARKER },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("admission-key");
  // opencodex really does own authentication here, so the host flag is correct.
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

test("auto-subscription emits no host-managed assertion (#253 class)", () => {
  const env = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
});

test("auto-absent emits both the marker and the host assertion", () => {
  const env = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// A user-exported API key is auth: detection sees it through the sanitized launch-env
// binding, so no proxy token is injected and no auth-conflict warning is provoked.
test("an exported ANTHROPIC_API_KEY keeps the token slot untouched", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user" },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
});

test("manual proxy injects the marker even when auth is present", () => {
  const env = buildClaudeEnv(cfg({ authMode: "proxy" }), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
});

test("manual subscription withholds the marker even when auth is absent", () => {
  const env = buildClaudeEnv(cfg({ authMode: "subscription" }), 10100, {}, {}, { authDetect: fileAuth("absent") });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

// ---------------------------------------------------------------------------
// #701 — project dotenv must not outrank a claude.ai subscription.
//
// Bun auto-loads `.env`/`.env.local` before any opencodex code runs, so process.env alone
// cannot tell ambient pollution from a real shell export. The Node launcher runs BEFORE
// that and records which slots already existed; these tests drive that marker directly.
// An absent marker means provenance is unknowable, so behavior must not change.
const PRE_BUN = "OCX_PRE_BUN_ANTHROPIC_ENV";

// The reported failure: auto mode, healthy claude.ai login, key only from the dotenv.
test("auto mode drops an Anthropic key that only Bun's dotenv introduced", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env[PRE_BUN]).toBeUndefined();
});

// A real shell export must still win — that is auto-mode API-key auth, which is supported.
test("a shell-exported Anthropic key survives the dotenv strip", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user", [PRE_BUN]: "ANTHROPIC_API_KEY" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
  expect(env[PRE_BUN]).toBeUndefined();
});

test("explicit subscription mode also drops a dotenv-only credential", () => {
  const env = buildClaudeEnv(
    cfg({ authMode: "subscription" }), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-dotenv", ANTHROPIC_AUTH_TOKEN: "token-from-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
});

// The admission key is opencodex's own gate, not user auth: it is injected after the strip.
test("the configured admission key survives the dotenv strip", () => {
  const env = buildClaudeEnv(
    cfg(undefined, [{ key: "admission-key" }]), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("admission-key");
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// Without the launcher marker (direct `bun src/cli/index.ts`, or an older launcher)
// provenance is unknowable, so an inherited key keeps its current meaning.
test("without the launcher marker an inherited key is left alone", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-user" },
    {},
    { authDetect: fileAuth("present") },
  );
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-user");
});

// Stripping the key must ALSO flip detection to absent so the proxy marker is injected.
// Binding detection to the pre-strip base left this user with no credential and no marker.
test("a stripped dotenv key lets detection fall through to the proxy marker", () => {
  const env = buildClaudeEnv(
    cfg(), 10100,
    { ANTHROPIC_API_KEY: "sk-ant-dotenv", [PRE_BUN]: "" },
    {},
    { authDetect: fileAuth("absent") },
  );
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// ---------------------------------------------------------------------------
// H2 (040_hardening): the settings.json env-hijack defence, proven per resolution.
//
// Claude Code strips provider-managed vars from SETTINGS-sourced env when
// CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set, so a leftover cc-switch/CCR
// ~/.claude/settings.json env block cannot silently steal routing. But the same flag
// is read as a host-auth assertion, so emitting it WITHOUT a host token makes a valid
// claude.ai subscription look logged out — that is the #253 failure. The flag is
// therefore correct exactly when opencodex owns authentication, and the auto path has
// to reach that conclusion on its own.
// ---------------------------------------------------------------------------

test("auto-resolved proxy emits the host-managed assertion with its token", () => {
  const env = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  // Auto found no Claude auth, so opencodex owns authentication here.
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
});

// The invariant that ties both halves together: the flag NEVER travels without a token.
test("the host-managed assertion never travels without a host token", () => {
  const cases: Array<[string, ReturnType<typeof buildClaudeEnv>]> = [
    ["auto-absent", buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") })],
    ["auto-present", buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") })],
    ["auto-unknown", buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("unknown") })],
    ["manual-proxy", buildClaudeEnv(cfg({ authMode: "proxy" }), 10100, {}, {}, { authDetect: fileAuth("present") })],
    ["manual-subscription", buildClaudeEnv(cfg({ authMode: "subscription" }), 10100, {}, {}, { authDetect: fileAuth("absent") })],
    ["admission-key", buildClaudeEnv(cfg(undefined, [{ key: "k" }]), 10100, {}, {}, { authDetect: fileAuth("present") })],
  ];
  for (const [label, env] of cases) {
    const hasToken = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.length > 0;
    const hasFlag = env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === "1";
    expect(`${label}:${hasFlag}`).toBe(`${label}:${hasToken}`);
  }
});

// The hijack itself. A cc-switch/CCR leftover puts a competing provider in
// settings.json `env`. Claude Code merges that block into the launch env; the strip is
// what keeps opencodex routing. We model the merge and assert the strip fires exactly
// when we asserted host ownership.
function simulateClaudeCodeSettingsMerge(
  launchEnv: Record<string, string | undefined>,
  settingsEnv: Record<string, string>,
): Record<string, string | undefined> {
  const PROVIDER_MANAGED = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ];
  const hostManaged = launchEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST === "1";
  const merged = { ...launchEnv };
  for (const [name, value] of Object.entries(settingsEnv)) {
    if (hostManaged && PROVIDER_MANAGED.includes(name)) continue; // managedEnv.ts strip
    merged[name] = value;
  }
  return merged;
}

const CC_SWITCH_LEFTOVER = {
  ANTHROPIC_BASE_URL: "https://hijacker.example.com",
  ANTHROPIC_AUTH_TOKEN: "sk-hijacker",
  ANTHROPIC_MODEL: "hijacker/model",
};

test("a leftover settings.json env block cannot hijack an auto-resolved proxy launch", () => {
  const launch = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("absent") });
  const merged = simulateClaudeCodeSettingsMerge(launch, CC_SWITCH_LEFTOVER);
  expect(merged.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
  expect(merged.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_MARKER);
  expect(merged.ANTHROPIC_MODEL).toBeUndefined();
});

test("an admission-key launch is defended the same way", () => {
  const launch = buildClaudeEnv(cfg(undefined, [{ key: "admission-key" }]), 10100, {}, {}, { authDetect: fileAuth("present") });
  const merged = simulateClaudeCodeSettingsMerge(launch, CC_SWITCH_LEFTOVER);
  expect(merged.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:10100");
  expect(merged.ANTHROPIC_AUTH_TOKEN).toBe("admission-key");
});

// THE DOCUMENTED RESIDUAL, asserted so it cannot drift into an assumed guarantee:
// subscription mode carries NO hijack defence, by design. Setting the flag to buy the
// strip would assert host auth we do not have and log the subscriber out (#253). A
// subscriber with a cc-switch leftover is genuinely still hijackable.
test("subscription mode has no hijack defence, by design", () => {
  const launch = buildClaudeEnv(cfg(), 10100, {}, {}, { authDetect: fileAuth("present") });
  expect(launch.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  const merged = simulateClaudeCodeSettingsMerge(launch, CC_SWITCH_LEFTOVER);
  // The leftover DOES win here. Choosing proxy mode explicitly is the escape hatch.
  expect(merged.ANTHROPIC_BASE_URL).toBe("https://hijacker.example.com");
});
