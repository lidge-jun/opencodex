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
  type AuthDetectDeps,
  type AuthPresence,
} from "../src/claude/auth-detect";

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

// The keychain probe must be metadata-only: -g and -w print password material.
// OBSERVED behaviour, not source shape — an assertion that slices this file passes
// trivially if the args are built dynamically, renamed, or moved, and this is the
// unit's top security invariant.
test("the default keychain probe never asks for secret material", () => {
  const calls: string[][] = [];
  const spy = spyOn(childProcess, "spawnSync").mockImplementation(((file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { status: 44, signal: null, error: undefined, stdout: null, stderr: null, output: [], pid: 0 };
  }) as never);
  try {
    expect(defaultAuthDetectDeps({}).keychainProbe()).toBe(process.platform === "darwin" ? "absent" : "absent");
    if (process.platform !== "darwin") return; // non-Darwin short-circuits before spawning
    expect(calls).toHaveLength(1);
    const [file, ...args] = calls[0]!;
    expect(file).toBe("security");
    expect(args).toEqual(["find-generic-password", "-s", "Claude Code-credentials"]);
    // -w prints the password, -g prints it to stderr. Neither may ever appear.
    expect(args).not.toContain("-w");
    expect(args).not.toContain("-g");
  } finally {
    spy.mockRestore();
  }
});

// The probe's stdio must stay fully ignored: -g writes to stderr, so a captured pipe
// would put secret material in our process even with correct args.
test("the default keychain probe captures no output streams", () => {
  let options: { stdio?: unknown } | undefined;
  const spy = spyOn(childProcess, "spawnSync").mockImplementation(((_f: string, _a: string[], o: { stdio?: unknown }) => {
    options = o;
    return { status: 44, signal: null, error: undefined, stdout: null, stderr: null, output: [], pid: 0 };
  }) as never);
  try {
    defaultAuthDetectDeps({}).keychainProbe();
    if (process.platform !== "darwin") return;
    expect(options?.stdio).toEqual(["ignore", "ignore", "ignore"]);
  } finally {
    spy.mockRestore();
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
