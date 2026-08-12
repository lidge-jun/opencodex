/**
 * Kiro (AWS CodeWhisperer) OAuth — import-first.
 *
 * Normal login imports the locally installed kiro-cli session. Account-add login deliberately
 * asks kiro-cli to switch identities in its supported browser flow, then imports that fresh session.
 *
 * Ported from jawcode packages/ai/src/providers/kiro.ts (readKiroCliSqlite, refreshKiroDesktopToken).
 * profileArn/region/client registration are persisted per OCX account so switching the account pool
 * never combines one account's access token with another account's local Kiro profile metadata.
 */
import type { KiroOAuthMetadata, OAuthController, OAuthCredentials } from "./types";
import {
  discardKiroCliSessionRecovery,
  inferRegionFromProfileArn,
  inspectKiroCliSqliteSources,
  inspectKiroCliSessionSnapshot,
  normalizeKiroRegion,
  persistKiroCliSessionRecovery,
  readImportedKiroCredential,
  readKiroCliSqliteCredential,
  resolveKiroCliExecutable,
  restoreKiroCliSession,
  restoreStaleKiroCliSessionRecovery,
  requireKiroRegion,
  type ImportedKiroCredential,
  type KiroCliSessionSnapshot,
  type KiroImportDiagnostic,
} from "./kiro-credentials";
import { homedir } from "node:os";
import { getAccountSet, saveAccountCredential } from "./store";

const DEFAULT_REGION = "us-east-1";
const REFRESH_URL = "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
const OIDC_URL = "https://oidc.{region}.amazonaws.com/token";
const KIRO_CLI_UNIX_INSTALL_COMMAND = "curl -fsSL https://cli.kiro.dev/install | bash";
const KIRO_CLI_WINDOWS_INSTALL_COMMAND = "irm 'https://cli.kiro.dev/install.ps1' | iex";
const KIRO_TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "refresh_token_reused",
  "revoked",
  "revoked_token",
  "refresh_token_revoked",
  "access_denied",
  "expired_token",
]);

interface ImportedKiroToken {
  access: string;
  refresh: string;
  expires: number;
}

export interface KiroCliCommandResult {
  exitCode: number;
  stdout: string;
}

export class KiroTokenRefreshError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly oauthError?: string,
  ) {
    super(`Kiro token refresh failed: ${httpStatus}${oauthError ? ` (${oauthError})` : ""}`);
    this.name = "KiroTokenRefreshError";
  }
}

export type KiroCliRunner = (args: string[], signal?: AbortSignal) => Promise<KiroCliCommandResult>;

export interface KiroLoginOptions {
  forceLogin?: boolean;
  cliRunner?: KiroCliRunner;
}

export function kiroCliInstallGuidance(platform = process.platform): string {
  return platform === "win32"
    ? `install the Kiro CLI in PowerShell (\`${KIRO_CLI_WINDOWS_INSTALL_COMMAND}\`)`
    : `install the Kiro CLI (\`${KIRO_CLI_UNIX_INSTALL_COMMAND}\`)`;
}

const pendingKiroLoginTransactions = new WeakMap<OAuthCredentials, KiroCliSessionSnapshot>();
/** Forced logins that started with no native CLI DB must logout on persistence failure. */
const pendingKiroEmptyPriorSessions = new WeakSet<OAuthCredentials>();


function resolveRuntimeKiroCliExecutable(): string {
  return resolveKiroCliExecutable({
    env: process.env,
    platform: process.platform,
    home: process.platform === "win32" ? homedir() : (process.env.HOME || homedir()),
  });
}

function logoutKiroCliBestEffort(): void {
  try {
    Bun.spawnSync([resolveRuntimeKiroCliExecutable(), "logout"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    // Best-effort rollback when the prior CLI state was empty.
  }
}

/** Settle the external CLI side of a forced login after OCX credential persistence resolves. */
export function settleKiroLoginTransaction(credential: OAuthCredentials, persisted: boolean): void {
  const snapshot = pendingKiroLoginTransactions.get(credential);
  const emptyPrior = pendingKiroEmptyPriorSessions.has(credential);
  pendingKiroLoginTransactions.delete(credential);
  pendingKiroEmptyPriorSessions.delete(credential);
  if (!persisted) {
    if (snapshot) {
      restoreKiroCliSession(snapshot);
      discardKiroCliSessionRecovery(snapshot);
      return;
    }
    if (emptyPrior) logoutKiroCliBestEffort();
    return;
  }
  if (snapshot) discardKiroCliSessionRecovery(snapshot);
}

function restoreKiroLoginOrThrow(snapshot: KiroCliSessionSnapshot | null, emptyPrior: boolean, cause: unknown): never {
  if (snapshot) {
    try {
      restoreKiroCliSession(snapshot);
      discardKiroCliSessionRecovery(snapshot);
    } catch (restoreError) {
      throw new AggregateError(
        [cause, restoreError],
        "Kiro login failed and the previous Kiro CLI session could not be restored.",
      );
    }
  } else if (emptyPrior) {
    logoutKiroCliBestEffort();
  }
  throw cause;
}

function throwIfKiroLoginCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Kiro login cancelled.");
}

async function defaultKiroCliRunner(args: string[], signal?: AbortSignal): Promise<KiroCliCommandResult> {
  throwIfKiroLoginCancelled(signal);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([resolveRuntimeKiroCliExecutable(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    throw new Error("Kiro CLI is not installed or could not be started.");
  }
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  // AbortSignal does not replay an abort that lands between the pre-check and listener registration.
  if (signal?.aborted) abort();
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : Promise.resolve(""),
    ]);
    throwIfKiroLoginCancelled(signal);
    return { exitCode, stdout };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Kiro profile ARN structure: arn:<partition>:codewhisperer:<region>:<account>:profile/<id> */
const KIRO_PROFILE_ARN_PATTERN = /^arn:[a-z0-9-]+:codewhisperer:[a-z0-9-]+:\d{12}:profile\/[A-Za-z0-9-]+$/;
const KIRO_PROFILE_ARN_MAX_LENGTH = 256;

function parseKiroProfileArn(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > KIRO_PROFILE_ARN_MAX_LENGTH) return undefined;
  return KIRO_PROFILE_ARN_PATTERN.test(trimmed) ? trimmed : undefined;
}

function profileArnFromWhoami(parsed: Record<string, unknown>): string | undefined {
  // Only narrowly-named documented-ish shapes; never invent an ARN (#993).
  return parseKiroProfileArn(parsed.profileArn)
    ?? parseKiroProfileArn(parsed.profile_arn)
    ?? (parsed.profile && typeof parsed.profile === "object" && !Array.isArray(parsed.profile)
      ? parseKiroProfileArn((parsed.profile as Record<string, unknown>).arn)
      : undefined);
}

async function readKiroCliIdentity(runner: KiroCliRunner, signal?: AbortSignal): Promise<{ email?: string; profileArn?: string }> {
  try {
    const result = await runner(["whoami", "--format", "json"], signal);
    if (result.exitCode !== 0) return {};
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
    const profileArn = profileArnFromWhoami(parsed);
    return {
      ...(email && email.length <= 320 ? { email } : {}),
      ...(profileArn ? { profileArn } : {}),
    };
  } catch {
    return {};
  }
}

function metadataFromImported(imported: ImportedKiroCredential): KiroOAuthMetadata | undefined {
  const metadata: KiroOAuthMetadata = {
    ...(imported.profileArn ? { profileArn: imported.profileArn } : {}),
    ...(imported.ssoRegion ? { ssoRegion: imported.ssoRegion } : {}),
    ...(imported.apiRegion ? { apiRegion: imported.apiRegion } : {}),
    ...(imported.clientId ? { clientId: imported.clientId } : {}),
    ...(imported.clientSecret ? { clientSecret: imported.clientSecret } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Persistable routing subset from explicit KIRO_* environment overrides (never local CLI state). */
export function environmentKiroRoutingMetadata(): Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion"> | undefined {
  const profileArn = process.env.KIRO_PROFILE_ARN?.trim() || undefined;
  const apiRegion = process.env.KIRO_API_REGION !== undefined
    ? requireKiroRegion(process.env.KIRO_API_REGION)
    : undefined;
  const ssoRegion = process.env.KIRO_REGION !== undefined
    ? requireKiroRegion(process.env.KIRO_REGION)
    : undefined;
  if (!profileArn && !apiRegion && !ssoRegion) return undefined;
  return {
    ...(profileArn ? { profileArn } : {}),
    ...(apiRegion ? { apiRegion } : {}),
    ...(ssoRegion ? { ssoRegion } : {}),
  };
}

/**
 * Before Add-account switches the external CLI identity, bind any matching legacy identity-less
 * OCX row to the current CLI session. Unmatched identity-less rows are left alone here so a
 * cancelled browser login cannot destroy the only stored credential; after a successful add they
 * remain selectable but cannot borrow the new CLI identity (and reauth refuses identity-less slots).
 */
async function bindMatchingLegacyIdentitylessKiroAccounts(
  runner: KiroCliRunner,
  signal?: AbortSignal,
): Promise<void> {
  const set = getAccountSet("kiro");
  if (!set) return;
  const legacyAccounts = set.accounts.filter(
    account => account.credential.accountId === undefined && account.credential.email === undefined,
  );
  if (legacyAccounts.length === 0) return;

  let imported: ImportedKiroCredential | null = null;
  try {
    imported = readKiroCliSqliteCredential();
  } catch {
    imported = null;
  }
  if (!imported?.refresh) return;

  for (const account of legacyAccounts) {
    const refresh = account.credential.refresh;
    if (!refresh || imported.refresh !== refresh) continue;
    const bound = await oauthCredentialFromImported(imported, runner, signal);
    if (!bound.accountId && !bound.email) continue;
    await saveAccountCredential("kiro", account.id, bound);
  }
}

async function oauthCredentialFromImported(
  imported: ImportedKiroCredential,
  runner: KiroCliRunner,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  let identity: { email?: string; profileArn?: string } = {};
  if (imported.source === "sqlite") {
    identity = await readKiroCliIdentity(runner, signal);
    // Session-switch race (#993 review): another process may have switched the
    // active Kiro CLI session between the SQLite read and whoami. Accept
    // whoami's identity only when the session token STILL matches the import —
    // refresh token, or access token when refresh is absent.
    if (identity.profileArn !== undefined) {
      const current = readKiroCliSqliteCredential();
      const importedKey = imported.refresh || imported.access;
      const currentKey = current ? current.refresh || current.access : "";
      if (!current || currentKey !== importedKey) identity = {};
    }
  }
  // Builder ID imports often lack a profileArn in SQLite; whoami against the
  // SAME active CLI session can supply it (#993). Imported stays authoritative.
  const resolvedProfileArn = imported.profileArn ?? identity.profileArn;
  const metadata: KiroOAuthMetadata | undefined = (() => {
    const base = metadataFromImported(imported) ?? {};
    if (resolvedProfileArn && !base.profileArn) base.profileArn = resolvedProfileArn;
    return Object.keys(base).length > 0 ? base : undefined;
  })();
  return {
    access: imported.access,
    refresh: imported.refresh,
    expires: imported.expires,
    source: imported.source === "json" ? "credential-file" : "local-cli",
    ...(resolvedProfileArn ? { accountId: resolvedProfileArn } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    ...(metadata ? { kiro: metadata } : {}),
  };
}

export type KiroCliImportDiagnosticStatus = KiroImportDiagnostic["status"];
export type KiroCliImportDiagnostic = KiroImportDiagnostic;

export function inspectKiroCliSqlite(): { token: ImportedKiroToken | null; diagnostics: KiroCliImportDiagnostic[] } {
  const { credential, diagnostics } = inspectKiroCliSqliteSources();
  return {
    token: credential ? { access: credential.access, refresh: credential.refresh, expires: credential.expires } : null,
    diagnostics,
  };
}

/** Read the kiro-cli SQLite token store (mac/linux). Returns null if no token found. */
export function readKiroCliSqlite(): ImportedKiroToken | null {
  const imported = readKiroCliSqliteCredential();
  return imported ? { access: imported.access, refresh: imported.refresh, expires: imported.expires } : null;
}

/**
 * Import-first login: kiro-cli SQLite → KIRO_ACCESS_TOKEN env → manual paste (CLI only).
 * When no local token is available, resolves the login flow via onAuth with instructions
 * so the GUI renders the paste-input field, then blocks on onManualCodeInput for the token.
 * If neither onAuth nor onManualCodeInput is available, throws a clear error.
 */
export async function loginKiro(ctrl: OAuthController, options: KiroLoginOptions = {}): Promise<OAuthCredentials> {
  const runner = options.cliRunner ?? defaultKiroCliRunner;
  // A prior process may have exited after switching the external CLI account but before
  // settlement. Recover that durable transaction before either importing or switching again.
  restoreStaleKiroCliSessionRecovery();
  if (options.forceLogin) {
    throwIfKiroLoginCancelled(ctrl.signal);
    ctrl.onAuth?.({
      url: "",
      instructions: "Kiro CLI is opening a fresh browser login. This also switches the account used by kiro-cli.",
    });
    ctrl.onProgress?.("Opening a fresh Kiro CLI browser login.");
    // Never log out of a session we could not capture: the recovery contract promises an exact
    // restore, so an uncapturable store (unreadable / schema-mismatched / ambiguous token) must
    // abort here rather than let a later failure destroy it permanently.
    const inspected = inspectKiroCliSessionSnapshot();
    if (inspected.blocked) {
      throw new Error(
        "Kiro CLI session could not be backed up, so OCX will not sign it out. " +
          "Repair or remove the unreadable kiro-cli credential database " +
          "(usually `~/.local/share/kiro-cli/data.sqlite3` or " +
          "`~/Library/Application Support/kiro-cli/data.sqlite3`, or " +
          "`%LOCALAPPDATA%\\Kiro-Cli\\data.sqlite3` on Windows), " +
          "unset KIROCLI_DB_PATH / KIRO_CLI_DB_FILE if set for import-only overrides, then retry.",
      );
    }
    const previousSession = inspected.snapshot;
    await bindMatchingLegacyIdentitylessKiroAccounts(runner, ctrl.signal);
    if (previousSession) persistKiroCliSessionRecovery(previousSession);
    try {
      const logout = await runner(["logout"], ctrl.signal);
      throwIfKiroLoginCancelled(ctrl.signal);
      if (logout.exitCode !== 0) throw new Error("Kiro CLI could not prepare a fresh login.");
      const login = await runner(["login"], ctrl.signal);
      throwIfKiroLoginCancelled(ctrl.signal);
      if (login.exitCode !== 0) throw new Error("Kiro CLI login did not complete successfully.");
      const fresh = readKiroCliSqliteCredential();
      if (!fresh) throw new Error("Kiro CLI login completed but no credential could be imported.");
      const credential = await oauthCredentialFromImported(fresh, runner, ctrl.signal);
      throwIfKiroLoginCancelled(ctrl.signal);
      if (!credential.accountId && !credential.email) {
        throw new Error("Kiro login completed but OCX could not determine a stable account identity.");
      }
      if (previousSession) pendingKiroLoginTransactions.set(credential, previousSession);
      else pendingKiroEmptyPriorSessions.add(credential);
      return credential;
    } catch (error) {
      restoreKiroLoginOrThrow(previousSession, !previousSession, error);
    }
  }

  const imported = readImportedKiroCredential();
  if (imported) {
    ctrl.onProgress?.(imported.source === "json" ? "Imported token from Kiro credentials file." : "Imported token from installed kiro-cli login.");
    return oauthCredentialFromImported(imported, runner, ctrl.signal);
  }

  const envToken = process.env.KIRO_ACCESS_TOKEN;
  if (envToken) {
    ctrl.onProgress?.("Using KIRO_ACCESS_TOKEN from environment.");
    const routing = environmentKiroRoutingMetadata();
    return {
      access: envToken,
      refresh: process.env.KIRO_REFRESH_TOKEN ?? "",
      expires: Date.now() + 3600_000,
      source: "environment",
      ...(routing ? { kiro: routing } : {}),
    };
  }

  if (ctrl.onManualCodeInput) {
    // Resolve the login flow immediately so the GUI receives instructions and
    // shows the paste-input field. Without this, onManualCodeInput blocks
    // forever and the HTTP response never reaches the dashboard.
    ctrl.onAuth?.({
      url: "",
      instructions:
        "No kiro-cli token found. Paste a Kiro access token below (starts with 'aoa'). " +
        `Otherwise ${kiroCliInstallGuidance()}, ` +
        "run `kiro-cli login`, and retry — or set KIRO_ACCESS_TOKEN.",
    });
    ctrl.onProgress?.("No kiro-cli token found. Paste a Kiro access token (starts with 'aoa'), or install the Kiro CLI and run `kiro-cli login` first.");
    const raw = (await ctrl.onManualCodeInput()).trim();
    if (raw) {
      const routing = environmentKiroRoutingMetadata();
      return {
        access: raw,
        refresh: "",
        expires: Date.now() + 3600_000,
        source: "manual",
        ...(routing ? { kiro: routing } : {}),
      };
    }
  }

  throw new Error(
    `Kiro: no token found. ${kiroCliInstallGuidance()} ` +
      "and run `kiro-cli login` to import its session, or set KIRO_ACCESS_TOKEN. " +
      "Browser login is not supported for Kiro.",
  );
}

/** Account metadata is authoritative; legacy accountless calls use KIRO_REGION → local import → default. */
export function resolveKiroRegion(account?: KiroOAuthMetadata): string {
  if (account !== undefined) return normalizeKiroRegion(account.ssoRegion) || DEFAULT_REGION;
  if (process.env.KIRO_REGION !== undefined) return requireKiroRegion(process.env.KIRO_REGION);
  return normalizeKiroRegion(readImportedKiroCredential()?.ssoRegion) || DEFAULT_REGION;
}

/** Account metadata is authoritative; legacy accountless calls may use KIRO_API_REGION/local import. */
export function resolveKiroApiRegion(account?: Pick<KiroOAuthMetadata, "apiRegion" | "profileArn" | "ssoRegion">): string {
  if (account !== undefined) {
    return (
      normalizeKiroRegion(account.apiRegion) ||
      inferRegionFromProfileArn(account.profileArn) ||
      normalizeKiroRegion(account.ssoRegion) ||
      DEFAULT_REGION
    );
  }
  if (process.env.KIRO_API_REGION !== undefined) return requireKiroRegion(process.env.KIRO_API_REGION);
  const imported = readImportedKiroCredential();
  return (
    normalizeKiroRegion(imported?.apiRegion) ||
    inferRegionFromProfileArn(imported?.profileArn) ||
    normalizeKiroRegion(imported?.ssoRegion) ||
    (process.env.KIRO_REGION !== undefined ? requireKiroRegion(process.env.KIRO_REGION) : undefined) ||
    DEFAULT_REGION
  );
}

/**
 * Resolve the CodeWhisperer profileArn for request-time use by the adapter.
 * Account metadata is authoritative. Legacy accountless calls use KIRO_PROFILE_ARN → local import.
 * Returns undefined if absent (the adapter decides whether that is fatal).
 */
export function resolveKiroProfileArn(account?: Pick<KiroOAuthMetadata, "profileArn">): string | undefined {
  if (account !== undefined) return account.profileArn;
  const env = process.env.KIRO_PROFILE_ARN;
  if (env) return env;
  return readImportedKiroCredential()?.profileArn;
}

async function kiroTokenRefreshError(response: Response): Promise<KiroTokenRefreshError> {
  let oauthError: string | undefined;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string" && KIRO_TERMINAL_REFRESH_ERRORS.has(payload.error)) {
      oauthError = payload.error;
    }
  } catch {
    // Error bodies are untrusted and intentionally excluded from the surfaced message.
  }
  return new KiroTokenRefreshError(response.status, oauthError);
}

async function readTokenResponse(res: Response, oldRefresh: string): Promise<OAuthCredentials> {
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  if (!data.accessToken) throw new Error("Kiro refresh returned no accessToken");
  return {
    access: data.accessToken,
    refresh: data.refreshToken || oldRefresh,
    expires: Date.now() + (data.expiresIn ?? 3600) * 1000,
  };
}

function kiroRefreshSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function refreshKiroDesktopToken(refresh: string, signal?: AbortSignal, metadata?: KiroOAuthMetadata): Promise<OAuthCredentials> {
  const region = resolveKiroRegion(metadata);
  const res = await fetch(REFRESH_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: refresh }),
    signal: kiroRefreshSignal(signal),
  });
  if (!res.ok) throw await kiroTokenRefreshError(res);
  return readTokenResponse(res, refresh);
}

async function refreshAwsSsoOidcToken(
  refresh: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  let metadata = credential?.kiro;
  if (!metadata) {
    const local = readImportedKiroCredential();
    // Only a local store holding this exact refresh token describes this account. Anything else
    // belongs to whichever account kiro-cli is currently signed into.
    if (local?.refresh === refresh) metadata = metadataFromImported(local);
  }
  // A stored OCX account with no usable `kiro` metadata must still refresh account-scoped: falling
  // through to `resolveKiroRegion(undefined)` would read KIRO_REGION or the local CLI import and
  // borrow an unrelated account's region after a switch. Environment/manual credentials may still
  // honor explicit KIRO_* routing; other stored accounts pin an empty marker (default region).
  // Only a truly accountless refresh (no stored credential) keeps the legacy env/local fallback.
  if (!metadata && credential) {
    metadata = credential.source === "environment" || credential.source === "manual"
      ? environmentKiroRoutingMetadata() ?? {}
      : {};
  }
  const clientId = metadata?.clientId;
  const clientSecret = metadata?.clientSecret;
  if (!clientId || !clientSecret) return refreshKiroDesktopToken(refresh, signal, metadata);
  const region = resolveKiroRegion(metadata);
  const run = async (refreshToken: string): Promise<Response> => fetch(OIDC_URL.replace("{region}", region), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "refresh_token",
      clientId,
      clientSecret,
      refreshToken,
    }),
    signal: kiroRefreshSignal(signal),
  });
  const res = await run(refresh);
  if (!res.ok) throw await kiroTokenRefreshError(res);
  return readTokenResponse(res, refresh);
}

function matchingRotatedKiroCliCredential(
  refresh: string,
  credential?: OAuthCredentials,
): ImportedKiroCredential | undefined {
  const storedIdentities = [credential?.kiro?.profileArn, credential?.accountId]
    .filter((value): value is string => Boolean(value));
  if (storedIdentities.length === 0 || new Set(storedIdentities).size !== 1) return undefined;
  try {
    const local = readKiroCliSqliteCredential();
    if (!local?.profileArn || storedIdentities.some(identity => identity !== local.profileArn)) return undefined;
    if (!local.refresh || local.refresh === refresh) return undefined;
    return local;
  } catch {
    // An unrelated or malformed local store must not block the stored OCX account.
    return undefined;
  }
}

function metadataForRotatedKiroCliCredential(
  credential: OAuthCredentials,
  local: ImportedKiroCredential,
): KiroOAuthMetadata {
  const {
    clientId: _storedClientId,
    clientSecret: _storedClientSecret,
    ...storedRouting
  } = credential.kiro ?? {};
  const localMetadata = metadataFromImported(local) ?? {};
  const {
    clientId: _localClientId,
    clientSecret: _localClientSecret,
    ...localRouting
  } = localMetadata;
  return {
    ...storedRouting,
    ...localRouting,
    ...(local.authType === "aws_sso_oidc" && local.clientId && local.clientSecret
      ? { clientId: local.clientId, clientSecret: local.clientSecret }
      : {}),
  };
}

export async function refreshKiroToken(
  refresh: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!refresh) throw new Error("Kiro: no refresh token available (re-run `kiro-cli login`).");
  try {
    return await refreshAwsSsoOidcToken(refresh, signal, credential);
  } catch (error) {
    if (!(error instanceof KiroTokenRefreshError) || error.httpStatus !== 400) throw error;
    if (!credential) throw error;
    const local = matchingRotatedKiroCliCredential(refresh, credential);
    if (!local) throw error;
    const retryMetadata = metadataForRotatedKiroCliCredential(credential, local);
    const fresh = await refreshAwsSsoOidcToken(local.refresh, signal, {
      ...credential,
      refresh: local.refresh,
      kiro: retryMetadata,
    });
    return { ...fresh, kiro: retryMetadata };
  }
}
