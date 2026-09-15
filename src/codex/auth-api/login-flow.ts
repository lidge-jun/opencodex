import { withCodexAccountLogLabel } from "../account-label";
import { getCodexAccountCredential, markCodexAccountValidated, readCodexAccountRecord, saveCodexAccountCredential, CodexCredentialRefreshLockTimeoutError, CodexCredentialRefreshBusyError, CodexCredentialRefreshStaleError } from "../account-store";
import { clearAccountQuota, isCodexQuotaExhausted, parseUsageQuota, setAccountQuotaFromParsed } from "../quota";
import type { StoredAccountQuota, WhamUsageResponse } from "../quota";
import { ConfigMutationLockError, withConfigMutationLockSync } from "../../config";
import { appendDefaultCodexAccountNamespace, codexAccountPickerEnabled } from "../account-namespaces";
import { catalogRefreshIsPending, normalizeCatalogDisposition } from "../catalog-refresh-status";
import { checkAccountIdCollision } from "../auth-collision";
import { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "../account-runtime-state";
import { clearCodexPoolRefreshFailure } from "../pool-refresh-backoff";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { emailMaskingEnabled, projectEmail } from "../../lib/privacy";
import { CodexWarmupError, codexWarmupFailureReason, isCodexWarmupProvisioningFailure, warmCodexAccount } from "../warmup";
import type { CodexAccount, CodexAccountCredentials, OcxConfig } from "../../types";
import type { CatalogDisposition } from "../convergence-types";
import { isValidCodexAccountId } from "../account-id";
import { codexAccountIdNamespaceCollisionError } from "../account-namespace-match";
import { jsonResponse } from "./http";
import { codexAuthLoginState, MAX_CODEX_LOGIN_STATE_ROWS, CODEX_LOGIN_TERMINAL_TTL_MS, CodexLoginStateBusyError, setCodexLoginState, pruneCodexLoginState, expireCodexAuthFlow } from "./login-state";
import type { CodexLoginStateRow } from "./login-state";
import { getRuntimeConfig, configuredPoolAccount, nonEmptyPlan, saveRuntimeConfig } from "./runtime-config";

const CODEX_CREDENTIAL_PERSISTENCE_ERROR = "Account was saved, but credential setup did not complete. Reauthenticate or remove the account.";
const CODEX_CREDENTIAL_PERSISTENCE_CODE = "codex_credential_persistence_failed";

export function codexAccountPersistenceConflict(
  config: OcxConfig,
  accountId: string,
  mode: "create" | "reauth",
): string | undefined {
  if (mode === "reauth") {
    return configuredPoolAccount(config, accountId)
      ? undefined
      : "Pool account was removed while login was in progress. Add it again as a new account.";
  }
  const namespaceCollision = codexAccountIdNamespaceCollisionError(config.codexAccountNamespaces, accountId);
  if (namespaceCollision) return namespaceCollision;
  return (config.codexAccounts ?? []).some(account => account.id === accountId)
    || Boolean(getCodexAccountCredential(accountId))
    ? `Account id already exists: ${accountId}`
    : undefined;
}

export async function verifyCodexAccountWarmup(
  accountId: string,
  accessToken: string,
  chatgptAccountId: string,
): Promise<{ ok: true; validatedAt: number } | { ok: false; response: Response }> {
  try {
    await warmCodexAccount({ accessToken, chatgptAccountId });
    return { ok: true, validatedAt: Date.now() };
  } catch (err) {
    const reason = codexWarmupFailureReason(err);
    if (err instanceof CodexWarmupError && err.code === "http_status" && err.status === 429) {
      return {
        ok: false,
        response: jsonResponse({
          error: "Codex account warmup was rate limited. Retry later or after the account's usage limit resets.",
          code: "codex_warmup_rate_limited",
          reason,
          accountId,
        }, 429),
      };
    }
    return {
      ok: false,
      response: jsonResponse({
        // Every fallback model was refused for a provisioning reason, so telling the operator to
        // reauthenticate sends them back through a login that already succeeded.
        error: isCodexWarmupProvisioningFailure(err)
          ? "Codex account warmup failed. Verify account model access or provisioning and try again."
          : "Codex account warmup failed. Reauthenticate the account and try again.",
        code: "codex_warmup_failed",
        reason,
        accountId,
      }, 401),
    };
  }
}

export interface StagedNewCodexAccountState {
  credential: CodexAccountCredentials;
  validatedAt?: number;
}

export type PersistNewCodexAccountOutcome =
  | { status: "committed"; pickerVisibilityChanged: boolean }
  | { status: "publication-failed"; pickerVisibilityChanged: boolean };

export function codexCredentialPersistenceFailure(accountId: string, catalogRefreshPending: boolean) {
  return {
    error: CODEX_CREDENTIAL_PERSISTENCE_ERROR,
    code: CODEX_CREDENTIAL_PERSISTENCE_CODE,
    accountId,
    needsReauth: true as const,
    ...(catalogRefreshPending ? { catalogRefreshPending: true as const } : {}),
  };
}

/** Persist config before publishing secret or runtime state under the shared mutation coordinator. */
export function persistNewCodexAccount(
  sourceConfig: OcxConfig,
  runtimeConfig: OcxConfig,
  addedAccount: CodexAccount,
  staged: StagedNewCodexAccountState,
): PersistNewCodexAccountOutcome {
  return withConfigMutationLockSync(() => {
    const previousConfig = { ...runtimeConfig };
    let pickerVisibilityChanged: boolean;
    try {
      const accounts = [...(runtimeConfig.codexAccounts ?? [])];
      const retainedPickerBindingRestored = codexAccountPickerEnabled(runtimeConfig)
        && Object.values(runtimeConfig.codexAccountNamespaces ?? {}).includes(addedAccount.id);
      accounts.push(addedAccount);
      runtimeConfig.codexAccounts = accounts;

      // Presence of the explicit flag distinguishes a dashboard-managed map from
      // a hand-authored legacy map. Preserve manual maps exactly.
      const tracksPickerNamespaces = runtimeConfig.codexAccountPickerEnabled !== undefined;
      if (tracksPickerNamespaces && runtimeConfig.codexAccountNamespaces) {
        runtimeConfig.codexAccountNamespaces = { ...runtimeConfig.codexAccountNamespaces };
      }
      const namespaceAdded = tracksPickerNamespaces
        && appendDefaultCodexAccountNamespace(runtimeConfig, addedAccount);
      pickerVisibilityChanged = namespaceAdded || retainedPickerBindingRestored;
      saveRuntimeConfig(sourceConfig, runtimeConfig);
    } catch (error) {
      for (const key of Object.keys(runtimeConfig) as Array<keyof OcxConfig>) {
        delete runtimeConfig[key];
      }
      Object.assign(runtimeConfig, previousConfig);
      throw error;
    }

    try {
      const generation = saveCodexAccountCredential(addedAccount.id, staged.credential, {
        validationPending: staged.validatedAt === undefined,
      });
      if (staged.validatedAt !== undefined) markCodexAccountValidated(addedAccount.id, staged.validatedAt, generation);
      clearAccountNeedsReauth(addedAccount.id);
    } catch {
      // Config is already durable. Return the failure outcome through the coordinator so its
      // generation commit is not rolled back while config.json remains changed.
      return { status: "publication-failed" as const, pickerVisibilityChanged };
    }
    return { status: "committed" as const, pickerVisibilityChanged };
  });
}

/** Bounded catalog-convergence callback supplied by the management dispatcher. */
export type CodexAuthCatalogConvergence = () => Promise<CatalogDisposition>;

export interface AccountNamespaceCatalogRefresh {
  catalogRefreshPending: boolean;
}

/** Collapse post-persistence convergence into the one public recovery bit. */
export async function convergeAccountNamespaceCatalog(
  config: OcxConfig,
  changed: boolean,
  convergeCodexCatalog?: CodexAuthCatalogConvergence,
): Promise<AccountNamespaceCatalogRefresh> {
  if (!changed || !codexAccountPickerEnabled(config)) {
    return { catalogRefreshPending: false };
  }
  if (!convergeCodexCatalog) return { catalogRefreshPending: true };

  try {
    const catalogRefresh = normalizeCatalogDisposition(await convergeCodexCatalog());
    if (!catalogRefresh) return { catalogRefreshPending: true };
    return { catalogRefreshPending: catalogRefreshIsPending(catalogRefresh) };
  } catch {
    return { catalogRefreshPending: true };
  }
}

export async function handleCodexAuthLoginStart(req: Request, config: OcxConfig, convergeCodexCatalog?: CodexAuthCatalogConvergence): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    reauth?: boolean;
    openBrowser?: unknown;
    device?: unknown;
  };
  // Device mode: no local browser, no loopback listener. The only way to add
  // an account to a headless hub (#3366).
  const useDeviceFlow = body.device === true;
  const requestedAccountId = body.id?.trim();
  const reauth = body.reauth === true;
  if (requestedAccountId && !isValidCodexAccountId(requestedAccountId)) {
    return jsonResponse({ error: "Invalid account id format" }, 400);
  }
  const accountId = requestedAccountId || `chatgpt-${Date.now()}`;
  const runtimeConfig = getRuntimeConfig(config);
  const preflightConflict = !reauth
    ? codexAccountPersistenceConflict(runtimeConfig, accountId, "create")
    : undefined;
  if (preflightConflict) return jsonResponse({ error: preflightConflict }, 400);
  if (reauth) {
    if (!requestedAccountId) return jsonResponse({ error: "id required for reauth" }, 400);
    if (!configuredPoolAccount(runtimeConfig, accountId)) {
      return jsonResponse({ error: "Unknown pool account for reauth" }, 404);
    }
  }
  pruneCodexLoginState();
  if (codexAuthLoginState.size >= MAX_CODEX_LOGIN_STATE_ROWS) {
    const busy = new CodexLoginStateBusyError();
    const response = jsonResponse({ error: busy.message, code: busy.code }, 503);
    response.headers.set("Retry-After", "1");
    return response;
  }
  const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const loginOwner: CodexLoginStateRow = { status: "starting", startedAt: Date.now() };
  codexAuthLoginState.set(flowId, loginOwner);
  try {
    const { startLoginFlow, getLoginStatus, publicOAuthAuthenticationErrorMessage } = await import("../../oauth");
    const result = await startLoginFlow("chatgpt", {
      forceLogin: true,
      ...(useDeviceFlow ? { flow: "device" as const } : {}),
    });

    // Open the browser server-side (same pattern as /api/oauth/login in management-api.ts).
    // The GUI's window.open is popup-blocked because it runs after an await, not a direct click.
    // Both login routes share one resolver so this surface cannot drift from the other.
    const { shouldOpenBrowserForLogin } = await import("../../oauth/open-browser-choice");
    // A device flow's URL is a verification page the user opens on ANOTHER
    // machine. Opening it on the hub host is useless at best, and on a
    // headless host it fails. `deviceCode` is the same signal the generic
    // OAuth login route uses to make this decision.
    if (result.url && !result.deviceCode && shouldOpenBrowserForLogin(body.openBrowser, runtimeConfig)) {
      const { openUrl } = await import("../../lib/open-url");
      openUrl(result.url);
    }

    (async () => {
      try {
        let completed = false;
        // The device grant lives 15 minutes and the whole point is that the
        // user walks to another device to enter the code. A 5-minute server
        // budget would kill the flow at minute five while the grant is still
        // valid. The extra 30 attempts past 450 are settlement margin: a user
        // who authorizes in the final seconds still needs the token exchange
        // and credential write to land before this loop gives up.
        const pollAttempts = useDeviceFlow ? 480 : 150;
        for (let i = 0; i < pollAttempts; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const st = getLoginStatus("chatgpt");
          if (st.done && st.loggedIn) {
            const { getCredential } = await import("../../oauth/store");
            const cred = getCredential("chatgpt");
            if (cred) {
              const oauthAccountId = cred.accountId;
              if (!oauthAccountId) {
                setCodexLoginState(flowId, {
                  status: "error",
                  error: "Could not determine account identity from OAuth tokens. Please retry OAuth login.",
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              let email = cred.email || accountId;
              let plan: string | undefined;
              let quota: Omit<StoredAccountQuota, "updatedAt"> | null = null;
              try {
                const tokens = { access_token: cred.access, account_id: oauthAccountId };
                const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                  headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                  signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                  const data = (await resp.json()) as WhamUsageResponse;
                  email = data.email ?? email;
                  plan = nonEmptyPlan(data.plan_type) ?? undefined;
                  quota = parseUsageQuota(data);
                }
              } catch { /* wham fetch is non-blocking */ }
              // Reauth must refresh the same ChatGPT identity already bound to this pool slot.
              // Otherwise a different login would silently overwrite credentials under a trusted id.
              if (reauth) {
                const existingCred = getCodexAccountCredential(accountId);
                const poolAccount = configuredPoolAccount(getRuntimeConfig(config), accountId);
                const expectedChatgptId = existingCred?.chatgptAccountId?.trim();
                const expectedEmail = poolAccount?.email?.trim().toLowerCase();
                const gotEmail = email.trim().toLowerCase();
                if (expectedChatgptId) {
                  if (expectedChatgptId !== oauthAccountId) {
                    setCodexLoginState(flowId, {
                      status: "error",
                      error: "Signed-in ChatGPT account does not match this pool account. Sign in with the same account, or remove it and add a new one.",
                      doneAt: Date.now(),
                    });
                    completed = true;
                    break;
                  }
                } else if (expectedEmail) {
                  if (!gotEmail || gotEmail !== expectedEmail) {
                    setCodexLoginState(flowId, {
                      status: "error",
                      error: "Signed-in ChatGPT account does not match this pool account. Sign in with the same account, or remove it and add a new one.",
                      doneAt: Date.now(),
                    });
                    completed = true;
                    break;
                  }
                } else {
                  // No chatgptAccountId and no pool email — refuse silent identity replacement
                  // (including empty credential slots that still have a pool row).
                  setCodexLoginState(flowId, {
                    status: "error",
                    error: "Cannot verify account identity for reauth. Remove this account and add it again.",
                    doneAt: Date.now(),
                  });
                  completed = true;
                  break;
                }
              }

              // 1.2: Duplicate check is scoped by personal vs workspace plan bucket.
              const collision = checkAccountIdCollision(oauthAccountId, email, plan, reauth ? accountId : undefined);
              if (collision.collision) {
                setCodexLoginState(flowId, {
                  status: "error", error: collision.reason, doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              // A successful authenticated WHAM read can prove quota is exhausted without
              // spending an inference request. Store the account, but defer inference validation
              // and keep it unavailable to routing. Unknown/failed usage reads retain the gate.
              const warmup = isCodexQuotaExhausted(quota, plan)
                ? { ok: true as const, validatedAt: undefined }
                : await verifyCodexAccountWarmup(accountId, cred.access, oauthAccountId);
              if (!warmup.ok) {
                const body = await warmup.response.json().catch(() => ({})) as { error?: string; code?: string; reason?: string };
                setCodexLoginState(flowId, {
                  status: "error",
                  error: body.reason ? `${body.error ?? "Codex account warmup failed"} (${body.reason})` : body.error ?? "Codex account warmup failed",
                  code: body.code,
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              const latestConfig = getRuntimeConfig(config);
              const accounts = latestConfig.codexAccounts ?? [];
              const existingIdx = accounts.findIndex(account => account.id === accountId);
              let pickerVisibilityChanged = false;
              let newAccountPersistence: PersistNewCodexAccountOutcome | null = null;
              const commitConflict = codexAccountPersistenceConflict(
                latestConfig,
                accountId,
                reauth ? "reauth" : "create",
              );
              if (commitConflict) {
                setCodexLoginState(flowId, {
                  status: "error",
                  error: commitConflict,
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              const credential: CodexAccountCredentials = {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: oauthAccountId,
              };

              if (existingIdx >= 0) {
                const generation = saveCodexAccountCredential(accountId, credential, {
                  validationPending: warmup.validatedAt === undefined,
                });
                // A successful reauthentication replaces the credential generation. Do not let a
                // failed optional WHAM probe make the replacement inherit quota from the old record.
                if (reauth) clearAccountQuota(accountId);
                // The refresh cooldown is learned about a CREDENTIAL, not about an account, and it
                // is keyed by account id alone. A replacement generation therefore inherits the
                // dead one's 15-60s quarantine: selection keeps excluding an account that was just
                // authenticated, and with a healthy sibling the thread detours and loses its warm
                // cache and continuation. A successful save is the proof the old failures were
                // about a credential that no longer exists.
                clearCodexPoolRefreshFailure(accountId);
                if (warmup.validatedAt !== undefined) markCodexAccountValidated(accountId, warmup.validatedAt, generation);
                clearAccountNeedsReauth(accountId);
                if (quota) setAccountQuotaFromParsed(accountId, quota);
                // Keep the pool id stable; refresh display metadata after a successful login/reauth.
                accounts[existingIdx] = withCodexAccountLogLabel({
                  ...accounts[existingIdx],
                  email,
                  plan: plan ?? accounts[existingIdx].plan,
                  isMain: false,
                }, accounts);
                latestConfig.codexAccounts = accounts;
                saveRuntimeConfig(config, latestConfig);
              } else {
                const addedAccount = withCodexAccountLogLabel({ id: accountId, email, plan, isMain: false }, accounts);
                newAccountPersistence = persistNewCodexAccount(
                  config,
                  latestConfig,
                  addedAccount,
                  {
                    credential,
                    validatedAt: warmup.validatedAt,
                  },
                );
                pickerVisibilityChanged = newAccountPersistence.pickerVisibilityChanged;
              }
              reconcileLiveStateStores();
              if (newAccountPersistence?.status === "publication-failed") {
                markAccountNeedsReauth(accountId);
              }
              // A new quota row is generation-gated by live account ownership. Reconcile the
              // durable config owner first so a partial prior sweep cannot reject this write.
              if (newAccountPersistence?.status === "committed" && quota) {
                setAccountQuotaFromParsed(accountId, quota);
              }
              const { catalogRefreshPending } = await convergeAccountNamespaceCatalog(
                latestConfig,
                pickerVisibilityChanged,
                convergeCodexCatalog,
              );
              if (newAccountPersistence?.status === "publication-failed") {
                setCodexLoginState(flowId, {
                  status: "error",
                  ...codexCredentialPersistenceFailure(accountId, catalogRefreshPending),
                  doneAt: Date.now(),
                });
                completed = true;
              } else {
                setCodexLoginState(flowId, {
                  status: "done",
                  accountId,
                  email,
                  ...(warmup.validatedAt === undefined ? { validationPending: true } : {}),
                  ...(catalogRefreshPending ? { catalogRefreshPending: true } : {}),
                  doneAt: Date.now(),
                });
                completed = true;
              }
            }
            break;
          }
          if (st.done && st.error) {
            setCodexLoginState(flowId, {
              status: "error",
              // startLoginFlow projects background failures before storing login status, so
              // fixed actionable OAuth messages retain their type-derived remediation here.
              error: st.error,
              doneAt: Date.now(),
            });
            completed = true;
            break;
          }
        }
        if (!completed) {
          setCodexLoginState(flowId, {
            status: "error",
            error: "Login timed out before OAuth completed.",
            doneAt: Date.now(),
          });
        }
      } catch (error) {
        const message = error instanceof ConfigMutationLockError
          || error instanceof CodexCredentialRefreshLockTimeoutError
          ? "Configuration is busy; retry login shortly."
          : error instanceof CodexCredentialRefreshBusyError || error instanceof CodexCredentialRefreshStaleError
            ? "Credential refresh is busy; retry login shortly."
          : publicOAuthAuthenticationErrorMessage(error);
        setCodexLoginState(flowId, {
          status: "error",
          error: message,
          doneAt: Date.now(),
        });
      } finally {
        // TTL: keep completed flow state available for clients that miss a short polling window.
        setTimeout(() => { if (codexAuthLoginState.get(flowId) === loginOwner) codexAuthLoginState.delete(flowId); }, CODEX_LOGIN_TERMINAL_TTL_MS);
      }
    })();

    setCodexLoginState(flowId, { status: "pending" });
    return jsonResponse({
      ok: true,
      flowId,
      url: result.url,
      instructions: result.instructions,
      // Dropped before #3366: every device-code surface renders this field,
      // so withholding it left the GUI and CLI with no code to show.
      ...(result.deviceCode ? { deviceCode: result.deviceCode } : {}),
    });
  } catch (e) {
    if (codexAuthLoginState.get(flowId) === loginOwner) codexAuthLoginState.delete(flowId);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "A login for chatgpt is already in progress") {
      return jsonResponse({ error: msg, status: "pending" }, 409);
    }
    if (e instanceof CodexCredentialRefreshBusyError || e instanceof CodexCredentialRefreshStaleError) {
      const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
      response.headers.set("Retry-After", "1");
      return response;
    }
    const { publicOAuthAuthenticationErrorMessage } = await import("../../oauth");
    return jsonResponse({ error: publicOAuthAuthenticationErrorMessage(e) }, 500);
  }
}

export async function handleCodexAuthLoginCode(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { flowId?: unknown; input?: unknown };
  const flowId = typeof body.flowId === "string" ? body.flowId.trim() : "";
  const input = typeof body.input === "string" ? body.input : "";
  if (!flowId) return jsonResponse({ error: "flowId required" }, 400);
  if (input.length > 4096) return jsonResponse({ error: "input too long" }, 400);

  // Import may yield; validate afterwards so cancel/replace cannot race a stale flow through.
  const { submitManualLoginCode } = await import("../../oauth");
  const flow = codexAuthLoginState.get(flowId);
  if (!flow) return jsonResponse({ error: "login flow expired or unknown" }, 400);
  if (flow.status !== "pending") return jsonResponse({ error: "login flow is not pending" }, 400);

  const result = submitManualLoginCode("chatgpt", input);
  if (!result.ok) return jsonResponse({ error: result.error }, 400);
  return jsonResponse({ ok: true }, 202);
}

export async function handleCodexAuthLoginCancel(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { flowId?: string };
  const { cancelLoginFlow } = await import("../../oauth");
  const cancelled = cancelLoginFlow("chatgpt");
  expireCodexAuthFlow(body.flowId ?? null);
  return jsonResponse({ ok: true, cancelled });
}

export async function handleCodexAuthLoginStatus(req: Request, url: URL, config: OcxConfig): Promise<Response> {
  const flowId = url.searchParams.get("flowId");
  const accountId = url.searchParams.get("accountId")?.trim();
  // Transient flow state carries the address of the account being added, so it follows the
  // same operator policy as the stored accounts it is about to become.
  const maskFlowEmails = emailMaskingEnabled(config);
  // Reauth always has a pre-existing credential; never treat "credential exists" as success
  // when the flow map entry is gone (would false-complete on lost/expired flow state).
  const reauthStatus = url.searchParams.get("reauth") === "1";
  if (flowId) {
    const st = codexAuthLoginState.get(flowId);
    if (
      !st
      && accountId
      && !reauthStatus
      && !isAccountNeedsReauth(accountId)
      && getCodexAccountCredential(accountId)
    ) {
      return jsonResponse({ status: "done", accountId,
        ...(readCodexAccountRecord(accountId)?.codexValidationPending ? { validationPending: true } : {}),
      });
    }
    return jsonResponse(st ? { ...st, email: projectEmail(st.email, maskFlowEmails) ?? undefined } : { status: "expired" });
  }
  // Legacy fallback: return latest pending flow
  for (const [, st] of codexAuthLoginState) {
    if (st.status === "pending") return jsonResponse({ ...st, email: projectEmail(st.email, maskFlowEmails) ?? undefined });
  }
  return jsonResponse({ status: "idle" });
}
