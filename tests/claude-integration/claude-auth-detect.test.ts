import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROXY_MARKER,
  claudeConfigDir,
  defaultAuthDetectDeps,
  ownAdmissionTokens,
  detectClaudeAuth,
  resolveClaudeKeychainPresence,
  type AuthDetectDeps,
  type AuthPresence,
} from "../../src/claude/auth-detect";
import { claudeKeychainReader } from "../../src/oauth/claude-keychain-read";

/**
 * The safety contract: `unknown` must never collapse into `absent`, because that is
 * what would flip a subscriber into proxy mode on a denied keychain prompt.
 */

function deps(overrides: Partial<AuthDetectDeps> = {}): AuthDetectDeps {
  return {
    readClaudeJson: () => undefined,
    credentialsFileExists: () => false,
    keychainProbe: () => "absent" as AuthPresence,
    env: () => ({}),
    ...overrides,
  };
}

test("S1: an oauthAccount with an email is present", () => {
  const result = detectClaudeAuth(deps({
    readClaudeJson: () => ({ oauthAccount: { emailAddress: "user@example.com" } }),
  }));
  expect(result.presence).toBe("present");
  expect(result.foundBy).toBe("claude-json-oauth");
  // The detail line is UI copy and must never carry the address itself.
  expect(JSON.stringify(result.sources)).not.toContain("user@example.com");
});

test("S1: a missing file is absent, a corrupt file is unknown", () => {
  expect(detectClaudeAuth(deps()).presence).toBe("absent");
  const corrupt = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new SyntaxError("Unexpected token"); },
  }));
  expect(corrupt.presence).toBe("unknown");
});

test("S1: an oauthAccount without a usable email is absent, not present", () => {
  expect(detectClaudeAuth(deps({ readClaudeJson: () => ({ oauthAccount: {} }) })).presence).toBe("absent");
  expect(detectClaudeAuth(deps({ readClaudeJson: () => ({ oauthAccount: { emailAddress: "  " } }) })).presence).toBe("absent");
});

test("S2: credentials file existence maps to present/absent, read errors to unknown", () => {
  expect(detectClaudeAuth(deps({ credentialsFileExists: () => true })).foundBy).toBe("claude-credentials-file");
  expect(detectClaudeAuth(deps({ credentialsFileExists: () => false })).presence).toBe("absent");
  const errored = detectClaudeAuth(deps({
    credentialsFileExists: () => { throw new Error("EACCES"); },
  }));
  expect(errored.presence).toBe("unknown");
});

test("S3: keychain present/absent/unknown pass through", () => {
  expect(detectClaudeAuth(deps({ keychainProbe: () => "present" })).foundBy).toBe("macos-keychain");
  expect(detectClaudeAuth(deps({ keychainProbe: () => "absent" })).presence).toBe("absent");
  expect(detectClaudeAuth(deps({ keychainProbe: () => "unknown" })).presence).toBe("unknown");
  const threw = detectClaudeAuth(deps({ keychainProbe: () => { throw new Error("spawn failed"); } }));
  expect(threw.presence).toBe("unknown");
});

test("S5: a user API key or auth token is present", () => {
  expect(detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_API_KEY: "sk-ant-x" }) })).foundBy).toBe("exported-env");
  expect(detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_AUTH_TOKEN: "user-token" }) })).foundBy).toBe("exported-env");
});

// THE feedback-loop guard: our own dummy must not read as user auth, or a proxy-mode
// launch would look authenticated on the next launch (devlog 002 §1).
test("S5: our own proxy marker is NOT auth, and is reported as stale", () => {
  const result = detectClaudeAuth(deps({ env: () => ({ ANTHROPIC_AUTH_TOKEN: PROXY_MARKER }) }));
  expect(result.presence).toBe("absent");
  expect(result.staleProxyMarker).toBe(true);
});

test("staleProxyMarker rides every aggregate branch", () => {
  const env = () => ({ ANTHROPIC_AUTH_TOKEN: PROXY_MARKER });
  expect(detectClaudeAuth(deps({ env, keychainProbe: () => "present" })).staleProxyMarker).toBe(true);
  expect(detectClaudeAuth(deps({ env, keychainProbe: () => "unknown" })).staleProxyMarker).toBe(true);
  expect(detectClaudeAuth(deps({ env })).staleProxyMarker).toBe(true);
});

test("aggregate: any present wins, unknown beats absent, all-absent is absent", () => {
  const mixed = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new Error("corrupt"); },
    keychainProbe: () => "present",
  }));
  expect(mixed.presence).toBe("present");
  expect(mixed.foundBy).toBe("macos-keychain");

  expect(detectClaudeAuth(deps({ keychainProbe: () => "unknown" })).presence).toBe("unknown");
  expect(detectClaudeAuth(deps()).presence).toBe("absent");
});

// The F1 invariant, stated as its own test so it cannot be softened by accident.
test("every source unknown aggregates to unknown, NEVER absent", () => {
  const result = detectClaudeAuth(deps({
    readClaudeJson: () => { throw new Error("corrupt"); },
    credentialsFileExists: () => { throw new Error("EACCES"); },
    keychainProbe: () => "unknown",
    env: () => { throw new Error("no env"); },
  }));
  expect(result.presence).toBe("unknown");
  expect(result.presence).not.toBe("absent");
});

test("claudeConfigDir honours CLAUDE_CONFIG_DIR", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/tmp/alt-profile" })).toBe("/tmp/alt-profile");
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "   " })).toContain(".claude");
  expect(claudeConfigDir({})).toContain(".claude");
});

// `os.homedir()` reads the OS user database and IGNORES a reassigned HOME, so a probe
// against an isolated profile would silently read the real user's files instead.
test("claudeConfigDir follows a reassigned HOME instead of the OS user database", () => {
  // `join` uses the platform separator, so compare against a joined path, not a literal.
  expect(claudeConfigDir({ HOME: join("/tmp", "fake-home") })).toBe(join("/tmp", "fake-home", ".claude"));
  expect(claudeConfigDir({ USERPROFILE: join("/tmp", "fake-profile") })).toBe(join("/tmp", "fake-profile", ".claude"));
});

// Same reason for ~/.claude.json: under CLAUDE_CONFIG_DIR it is that dir's SIBLING.
test("the default claude.json reader stays inside the overridden profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-authdetect-"));
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({
    oauthAccount: { emailAddress: "someone@example.com" },
  }));
  const deps = defaultAuthDetectDeps({ CLAUDE_CONFIG_DIR: join(dir, ".claude") });
  expect(deps.readClaudeJson()?.oauthAccount).toBeDefined();
  expect(defaultAuthDetectDeps({ HOME: dir }).readClaudeJson()?.oauthAccount).toBeDefined();
});

// The Keychain source is resolved once, asynchronously, by the caller (#8161). Detection itself
// never spawns: a synchronous `security` child can only be bounded by killing it.
test("the default keychain source is the caller's pre-resolved presence and never spawns", () => {
  const spawned: string[] = [];
  const spies = (["spawn", "spawnSync", "execFileSync", "execSync"] as const).map(name =>
    spyOn(childProcess, name).mockImplementation(((file: string) => { spawned.push(`${name}:${file}`); throw new Error("no spawn"); }) as never));
  try {
    // Unresolved on macOS is unknown, which maps to subscription and never to proxy.
    expect(defaultAuthDetectDeps({}).keychainProbe()).toBe(process.platform === "darwin" ? "unknown" : "absent");
    for (const presence of ["present", "absent", "unknown"] as const) {
      expect(defaultAuthDetectDeps({}, [], presence).keychainProbe()).toBe(presence);
    }
    expect(detectClaudeAuth({ ...defaultAuthDetectDeps({}, [], "unknown"), readClaudeJson: () => undefined, credentialsFileExists: () => false }).presence).toBe("unknown");
    expect(spawned).toEqual([]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("resolveClaudeKeychainPresence answers from the shared Keychain reader's async probe", async () => {
  for (const presence of ["present", "absent", "unknown"] as const) {
    const probe = spyOn(claudeKeychainReader, "probe").mockResolvedValue(presence);
    try {
      expect(await resolveClaudeKeychainPresence()).toBe(presence);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
    }
  }
});


test("a manual authMode never probes the Keychain, and auto still does", async () => {
  const probe = spyOn(claudeKeychainReader, "probe").mockResolvedValue("present");
  try {
    for (const mode of ["proxy", "subscription"]) {
      // Detection is discarded for a pinned mode, so no wait and no unlock prompt for it.
      expect(await resolveClaudeKeychainPresence(mode)).toBe(process.platform === "darwin" ? "unknown" : "absent");
    }
    expect(probe).toHaveBeenCalledTimes(0);
    expect(await resolveClaudeKeychainPresence("auto")).toBe("present");
    expect(await resolveClaudeKeychainPresence(undefined)).toBe("present");
    expect(probe).toHaveBeenCalledTimes(2);
  } finally {
    probe.mockRestore();
  }
});
test("defaultAuthDetectDeps binds env to the caller-supplied environment", () => {
  const real = defaultAuthDetectDeps({ ANTHROPIC_API_KEY: "sk-ant-from-base" });
  expect(real.env().ANTHROPIC_API_KEY).toBe("sk-ant-from-base");
  // And the production path aggregates from it.
  const result = detectClaudeAuth({ ...real, readClaudeJson: () => undefined, credentialsFileExists: () => false, keychainProbe: () => "absent" });
  expect(result.presence).toBe("present");
  expect(result.foundBy).toBe("exported-env");
});

// MAJOR (round-5 review): the system-env writer exports the CONFIGURED admission key
// into ANTHROPIC_AUTH_TOKEN. Counting it would make opencodex's own output look like
// proof the user can authenticate natively — the marker feedback loop, one variable over.
test("opencodex's own admission key is not counted as user auth", () => {
  const base = {
    readClaudeJson: () => undefined,
    credentialsFileExists: () => false,
    keychainProbe: () => "absent" as const,
  };
  const own = detectClaudeAuth({
    ...base,
    env: () => ({ ANTHROPIC_AUTH_TOKEN: "sk-ocx-admission" }),
    ownTokens: ["sk-ocx-admission"],
  });
  expect(own.presence).toBe("absent");

  // Same value in ANTHROPIC_API_KEY is ours too.
  expect(detectClaudeAuth({
    ...base,
    env: () => ({ ANTHROPIC_API_KEY: "sk-ocx-admission" }),
    ownTokens: ["sk-ocx-admission"],
  }).presence).toBe("absent");

  // A DIFFERENT value is genuine user auth and still counts.
  const user = detectClaudeAuth({
    ...base,
    env: () => ({ ANTHROPIC_AUTH_TOKEN: "sk-ant-user" }),
    ownTokens: ["sk-ocx-admission"],
  });
  expect(user.presence).toBe("present");
  expect(user.foundBy).toBe("exported-env");
});

// ownAdmissionTokens must read the configured pool, and tolerate an absent one.
test("ownAdmissionTokens reads configured admission keys", () => {
  expect(ownAdmissionTokens({ apiKeys: [{ key: "a" }, { key: "b" }] })).toEqual(["a", "b"]);
  expect(ownAdmissionTokens({})).toEqual([]);
});
