/**
 * Claude auth presence detection.
 *
 * THREE values, not two. `unknown` means a source could not be READ (denied keychain,
 * permission error, corrupt JSON) — treating that as `absent` would silently flip a
 * subscriber into proxy mode, which is the failure this whole unit exists to prevent
 * (devlog/_plan/260726_claude_auth_auto/001 F1). The resolver maps unknown to the
 * historical default (subscription), never to proxy.
 *
 * IO is injectable so every source is testable without touching the real home
 * directory, keychain, or environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type AuthPresence = "present" | "absent" | "unknown";

export type AuthSourceId =
  | "claude-json-oauth"        // S1: <config-dir>/../.claude.json oauthAccount
  | "claude-credentials-file"  // S2: <config-dir>/.credentials.json
  | "macos-keychain"           // S3: security find-generic-password (metadata only)
  | "exported-env";            // S5: ANTHROPIC_API_KEY / a USER's ANTHROPIC_AUTH_TOKEN

// NOTE: there is deliberately no "opencodex anthropic OAuth" source. That is a
// PROVIDER credential in opencodex's own store which the Claude CLI never consumes,
// so it is not evidence the client can authenticate natively (audit 002 §5).

/**
 * The one opencodex-owned dummy token. Exported so the CLI, the system-env writer and
 * the tests all compare against the same literal — a second copy is how the marker
 * feedback loop (002 §1) sneaks back in.
 */
export const PROXY_MARKER = "opencodex-proxy";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** `security` exit code for "the item does not exist" — a real absent, not a failure. */
const KEYCHAIN_ITEM_NOT_FOUND = 44;
const KEYCHAIN_TIMEOUT_MS = 1_500;

export interface AuthSourceResult {
  source: AuthSourceId;
  presence: AuthPresence;
  /** One short, credential-free line. Never contains token material. */
  detail?: string;
}

export interface AuthDetectDeps {
  /** Parsed ~/.claude.json; undefined when missing; throws on corrupt/unreadable. */
  readClaudeJson(): Record<string, unknown> | undefined;
  /** Whether <config-dir>/.credentials.json exists; throws on read error. */
  credentialsFileExists(): boolean;
  /** present/absent/unknown for the macOS keychain probe; absent on non-Darwin. */
  keychainProbe(): AuthPresence;
  /**
   * The environment to inspect for S5. Callers pass the SAME base env the launch will
   * use, so detection and the spawned process can never disagree. Injection is typed
   * to exclude this key (see `detectClaudeAuth` callers) so a test fake cannot
   * silently replace the binding.
   */
  env(): NodeJS.ProcessEnv;
  /**
   * Token values opencodex itself put into the environment. `system-env.ts` exports the
   * configured admission key as `ANTHROPIC_AUTH_TOKEN`, so without this the detector
   * reads OUR OWN output back as proof the user can authenticate natively — the same
   * feedback loop the `PROXY_MARKER` guard closes, one variable over.
   */
  ownTokens?: readonly string[];
}

export interface AuthDetectResult {
  /** present if ANY source is present; unknown if none present but ANY unknown. */
  presence: AuthPresence;
  /** The source that proved presence, when any — feeds the GUI reason badge. */
  foundBy?: AuthSourceId;
  sources: AuthSourceResult[];
  /**
   * True when the inspected env carries OUR OWN dummy marker. It must never count as
   * user auth, and a subscription resolution strips it before launch (002 §1).
   */
  staleProxyMarker: boolean;
}

/** Claude Code config dir: `CLAUDE_CONFIG_DIR` override, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : join(homeDir(env), ".claude");
}

/**
 * `os.homedir()` reads the OS user database and ignores a reassigned `HOME`, which
 * makes an isolated-profile probe silently read the real user's files. Prefer the
 * environment the caller handed us; fall back to the OS value.
 */
function homeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOME?.trim() || env.USERPROFILE?.trim();
  return fromEnv ? fromEnv : homedir();
}

function detectClaudeJson(deps: AuthDetectDeps): AuthSourceResult {
  try {
    const parsed = deps.readClaudeJson();
    if (parsed === undefined) return { source: "claude-json-oauth", presence: "absent" };
    const account = parsed.oauthAccount;
    if (account && typeof account === "object" && !Array.isArray(account)) {
      const email = (account as Record<string, unknown>).emailAddress;
      if (typeof email === "string" && email.trim().length > 0) {
        // Never echo the address itself — the detail line is UI copy, not a credential.
        return { source: "claude-json-oauth", presence: "present", detail: "oauthAccount" };
      }
    }
    return { source: "claude-json-oauth", presence: "absent" };
  } catch {
    // Corrupt or unreadable is NOT absent (F1).
    return { source: "claude-json-oauth", presence: "unknown", detail: "unreadable" };
  }
}

function detectCredentialsFile(deps: AuthDetectDeps): AuthSourceResult {
  try {
    return {
      source: "claude-credentials-file",
      presence: deps.credentialsFileExists() ? "present" : "absent",
    };
  } catch {
    return { source: "claude-credentials-file", presence: "unknown", detail: "unreadable" };
  }
}

function detectKeychain(deps: AuthDetectDeps): AuthSourceResult {
  try {
    return { source: "macos-keychain", presence: deps.keychainProbe() };
  } catch {
    return { source: "macos-keychain", presence: "unknown", detail: "probe failed" };
  }
}

function detectExportedEnv(deps: AuthDetectDeps): AuthSourceResult {
  try {
    const env = deps.env();
    const isOwn = (value: string): boolean =>
      value === PROXY_MARKER || (deps.ownTokens ?? []).includes(value);
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (apiKey && !isOwn(apiKey)) {
      return { source: "exported-env", presence: "present", detail: "ANTHROPIC_API_KEY" };
    }
    const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
    // Our own dummy is opencodex state, never user auth: counting it would make a
    // proxy-mode launch look authenticated on the NEXT launch (002 §1). The configured
    // admission key is opencodex state for exactly the same reason — the system-env
    // writer exports it into this very variable.
    if (token && !isOwn(token)) {
      return { source: "exported-env", presence: "present", detail: "ANTHROPIC_AUTH_TOKEN" };
    }
    return { source: "exported-env", presence: "absent" };
  } catch {
    return { source: "exported-env", presence: "unknown" };
  }
}

export function detectClaudeAuth(deps: AuthDetectDeps): AuthDetectResult {
  const sources = [
    detectClaudeJson(deps),
    detectCredentialsFile(deps),
    detectKeychain(deps),
    detectExportedEnv(deps),
  ];
  let staleProxyMarker = false;
  try {
    staleProxyMarker = deps.env().ANTHROPIC_AUTH_TOKEN?.trim() === PROXY_MARKER;
  } catch {
    staleProxyMarker = false;
  }

  const present = sources.find(source => source.presence === "present");
  if (present) return { presence: "present", foundBy: present.source, sources, staleProxyMarker };
  if (sources.some(source => source.presence === "unknown")) {
    return { presence: "unknown", sources, staleProxyMarker };
  }
  return { presence: "absent", sources, staleProxyMarker };
}

/**
 * Real IO. The keychain probe is METADATA ONLY: no `-g` and no `-w`, because those
 * flags print the password itself. We only need the exit code.
 */
export function defaultAuthDetectDeps(
  env: NodeJS.ProcessEnv = process.env,
  ownTokens: readonly string[] = [],
): AuthDetectDeps {
  const configDir = claudeConfigDir(env);
  return {
    readClaudeJson() {
      // Sibling of the config dir when CLAUDE_CONFIG_DIR is set, else ~/.claude.json.
      const path = env.CLAUDE_CONFIG_DIR?.trim()
        ? join(configDir, "..", ".claude.json")
        : join(homeDir(env), ".claude.json");
      if (!existsSync(path)) return undefined;
      // A parse failure propagates so the caller records `unknown`, not `absent`.
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    },
    credentialsFileExists() {
      return existsSync(join(configDir, ".credentials.json"));
    },
    keychainProbe() {
      if (process.platform !== "darwin") return "absent";
      const result = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
        timeout: KEYCHAIN_TIMEOUT_MS,
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (result.error || result.signal !== null) return "unknown";
      if (result.status === 0) return "present";
      if (result.status === KEYCHAIN_ITEM_NOT_FOUND) return "absent";
      return "unknown";
    },
    env: () => env,
    ownTokens,
  };
}

/**
 * The token values opencodex itself exports. Configured admission keys land in
 * `ANTHROPIC_AUTH_TOKEN` (see `system-env.ts`), so detection must not read them back
 * as user auth.
 */
export function ownAdmissionTokens(config: { apiKeys?: Array<{ key: string }> }): string[] {
  return (config.apiKeys ?? []).map(entry => entry.key).filter(key => key.length > 0);
}
