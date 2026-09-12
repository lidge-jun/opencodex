/**
 * Devin CLI credential import.
 *
 * The installed CLI writes `credentials.toml` after `devin auth login`, and the
 * `windsurf_api_key` in it is an ordinary `devin-session-token$<JWT>` — the same
 * shape RegisterUser returns for `ocx login devin`, and the same one the
 * cloud-direct client already speaks. Measured against a signed-in CLI: it mints
 * a user_jwt, opens the full model catalog, and streams chat.
 *
 * So this is kiro's import-first login with the same substance: adopt a signed-in
 * local CLI's own session rather than starting a browser flow the CLI already
 * completed. No browser is ever opened, because there is nothing left for
 * opencodex to authorize.
 *
 * The file also carries `devin_webapp_host` and `devin_api_url`, which belong to
 * the Devin *session* product (`cog_` keys, agent VMs) rather than to model
 * inference. Neither is read here.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { identityFromApiKey } from "./devin";
import { resolveDevinApiBaseUrl } from "./devin/api-base";
import type { OAuthController, OAuthCredentials } from "./types";

/**
 * How to get a signed-in CLI, for the one error that needs to say so.
 *
 * This flow reads `credentials.toml` and never executes the CLI, so it does not
 * resolve the binary. The constant used to live beside the discovery helper the
 * retired ACP adapter needed; that adapter is gone and this sentence is all that
 * outlived it.
 */
const DEVIN_CLI_INSTALL_HINT =
  "Install the Devin CLI with `curl -fsSL https://cli.devin.ai/install.sh | bash` or `brew install --cask devin-cli`, then run `devin auth login`.";

/**
 * Structurally the `LoginOpts` from `./index`, restated here rather than imported.
 * `index.ts` imports this module to register the provider, so importing the type
 * back would close a cycle for one optional field this flow does not branch on:
 * an import has nothing to force, so `forceLogin` is a no-op for it.
 */
type DevinCliLoginOpts = { forceLogin?: boolean };

/** Absolute-path override, for a CLI installed somewhere this resolver does not model. */
export const DEVIN_CLI_CREDENTIALS_ENV = "OPENCODEX_DEVIN_CLI_CREDENTIALS";

export interface DevinCliLoginDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

/**
 * Where the CLI keeps its own credential.
 *
 * Measured on a live install: `$XDG_DATA_HOME/devin/credentials.toml`, i.e.
 * `~/.local/share/devin/...`, which `devin auth status` prints. Note this is the
 * DATA dir, not the config dir — an earlier draft guessed `~/.config` and was
 * wrong. The Windows branch mirrors the CLI's own installer.
 */
export function devinCliCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env[DEVIN_CLI_CREDENTIALS_ENV]?.trim();
  // Absolute only. A relative override would resolve against whatever directory
  // the proxy happens to be running in, which is not a location a user can mean.
  if (override && (override.startsWith("/") || /^[A-Za-z]:[\\/]/.test(override))) return override;
  const paths = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    // `??` treats an empty APPDATA as set, and join("", "devin", …) is a path
    // relative to whatever directory the proxy was started in — so a file planted
    // there would import as the operator's own CLI session. An empty or
    // whitespace-only value is an absent value.
    const appData = env.APPDATA?.trim() || paths.join(homedir(), "AppData", "Roaming");
    return paths.join(appData, "devin", "credentials.toml");
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || paths.join(homedir(), ".local", "share");
  return paths.join(dataHome, "devin", "credentials.toml");
}

export interface DevinCliCredentialFile {
  apiKey: string;
  apiServerUrl: string;
}

/**
 * Upper bound on the credential file we are willing to parse.
 *
 * The measured file is four short lines. Reading an arbitrarily large file into
 * a string and running two global-ish regexes over it is work we never need to
 * do, and a file this size is not the CLI's.
 */
const DEVIN_CLI_CREDENTIALS_MAX_BYTES = 64 * 1024;

/**
 * Why the import has no credential, for the one error message the caller owns.
 *
 * `missing` and `unreadable` used to collapse into the same `undefined`, so a
 * permission error on an existing file was reported as "not signed in" and sent
 * the operator to `devin auth login`, which does not fix it.
 */
export type DevinCliCredentialOutcome =
  | { kind: "ok"; file: DevinCliCredentialFile }
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "incomplete" };

export function readDevinCliCredentialOutcome(deps: DevinCliLoginDeps = {}): DevinCliCredentialOutcome {
  const path = devinCliCredentialsPath(deps.env, deps.platform);
  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return { kind: "missing" };
  let raw: string;
  try {
    raw = (deps.read ?? ((p: string) => readFileSync(p, "utf8")))(path);
  } catch {
    // Nothing from the error is repeated: it carries the path, and an EACCES
    // message is not worth the risk of echoing anything read off disk.
    return { kind: "unreadable" };
  }
  if (raw.length > DEVIN_CLI_CREDENTIALS_MAX_BYTES) return { kind: "unreadable" };
  const apiKey = raw.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  const apiServerUrl = raw.match(/^\s*api_server_url\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  if (!apiKey || !apiServerUrl) return { kind: "incomplete" };
  return { kind: "ok", file: { apiKey, apiServerUrl } };
}

/**
 * Read the two keys that matter, and nothing else.
 *
 * The measured file is four flat `key = "value"` lines: no tables, no comments,
 * no single quotes. A line matcher is therefore enough and a TOML dependency is
 * not, and the quoted form is required rather than optional — an unquoted
 * matcher would pass its own fixtures and miss the real file.
 *
 * Returns undefined rather than throwing so the caller owns the one error
 * message. Nothing here ever puts the file's contents into a thrown value.
 */
export function readDevinCliCredentialFile(deps: DevinCliLoginDeps = {}): DevinCliCredentialFile | undefined {
  const outcome = readDevinCliCredentialOutcome(deps);
  return outcome.kind === "ok" ? outcome.file : undefined;
}

/** True when a signed-in CLI credential is readable. Used for status, never for auth. */
export function devinCliSignedIn(deps: DevinCliLoginDeps = {}): boolean {
  return readDevinCliCredentialFile(deps) !== undefined;
}

export async function loginDevinCli(
  ctrl: OAuthController,
  _opts?: DevinCliLoginOpts,
  deps: DevinCliLoginDeps = {},
): Promise<OAuthCredentials> {
  const outcome = readDevinCliCredentialOutcome(deps);
  // Each branch deliberately names no path contents and no parsed value. A
  // Connect error can echo a request, and redactSecretString does not recognise
  // a bare JWT or a devin-session-token, which is why register-user.ts refuses
  // to repeat error bodies; the same caution applies to anything thrown here.
  if (outcome.kind === "unreadable") {
    // The file is there and we could not read it, so `devin auth login` is the
    // wrong instruction: it would succeed and change nothing.
    throw new Error(
      "Found a Devin CLI credential file but could not read it. Check its permissions and size, then try again.",
    );
  }
  if (outcome.kind === "incomplete") {
    throw new Error(
      "The Devin CLI credential file is missing its session key or API server URL. Run `devin auth login` again to rewrite it.",
    );
  }
  if (outcome.kind === "missing") {
    throw new Error(
      `No signed-in Devin CLI session found. ${DEVIN_CLI_INSTALL_HINT} Then run \`devin auth login\` and try again.`,
    );
  }
  const file = outcome.file;
  // The host comes off disk and then receives the key, so it passes the same
  // allowlist as the RegisterUser host. An unallowlisted value falls back to the
  // default rather than becoming an exfiltration target.
  const apiBaseUrl = resolveDevinApiBaseUrl(file.apiServerUrl);
  ctrl.onProgress?.("Imported the signed-in Devin CLI session.");
  return {
    access: file.apiKey,
    // Cognition issues a durable key and exposes no refresh endpoint. Carrying
    // the key here rather than "" is the house pattern: an empty refresh makes
    // detectOAuthWarning report stale_credentials from the moment of login.
    refresh: file.apiKey,
    expires: Number.MAX_SAFE_INTEGER,
    source: "local-cli",
    apiBaseUrl,
    ...identityFromApiKey(file.apiKey),
  };
}

export async function refreshDevinCliToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  _credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  // The CLI owns this session and Cognition has no refresh endpoint. Extending
  // the stored expiry would make a revoked key look valid forever; throwing lets
  // the request path mark the account needsReauth instead.
  throw new Error("invalid_grant: the Devin CLI owns this session. Run devin auth login again.");
}
