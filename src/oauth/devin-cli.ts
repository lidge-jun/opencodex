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
import { DEVIN_CLI_INSTALL_HINT } from "../adapters/devin-cli/binary";
import { identityFromApiKey } from "./devin";
import { resolveDevinApiBaseUrl } from "./devin/api-base";
import type { OAuthController, OAuthCredentials } from "./types";

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
    const appData = env.APPDATA ?? paths.join(homedir(), "AppData", "Roaming");
    return paths.join(appData, "devin", "credentials.toml");
  }
  const dataHome = env.XDG_DATA_HOME ?? paths.join(homedir(), ".local", "share");
  return paths.join(dataHome, "devin", "credentials.toml");
}

export interface DevinCliCredentialFile {
  apiKey: string;
  apiServerUrl: string;
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
  const path = devinCliCredentialsPath(deps.env, deps.platform);
  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return undefined;
  let raw: string;
  try {
    raw = (deps.read ?? ((p: string) => readFileSync(p, "utf8")))(path);
  } catch {
    return undefined;
  }
  const apiKey = raw.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  const apiServerUrl = raw.match(/^\s*api_server_url\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  if (!apiKey || !apiServerUrl) return undefined;
  return { apiKey, apiServerUrl };
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
  const file = readDevinCliCredentialFile(deps);
  if (!file) {
    // Deliberately names no path contents and no parsed value. A Connect error
    // can echo a request, and redactSecretString does not recognise a bare JWT
    // or a devin-session-token, which is why register-user.ts refuses to repeat
    // error bodies; the same caution applies to anything thrown from here.
    throw new Error(
      `No signed-in Devin CLI session found. ${DEVIN_CLI_INSTALL_HINT} Then run \`devin auth login\` and try again.`,
    );
  }
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
