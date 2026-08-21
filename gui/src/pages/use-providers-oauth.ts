import { useCallback, useRef } from "react";
import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import type { OAuthAccount, OAuthStatus } from "./providers-shared";
import { oauthLabel } from "./providers-shared";

/**
 * Tagged error for internally mapped API/validation failures — only these are safe to render.
 * Transport/fetch rejections never use this type and are mapped to prov.networkError.
 */
export class SafeManualCodeError extends Error {
  readonly safe = true as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafeManualCodeError";
  }
}
/** Exported for tests: map API error string + status to localized key. */
export function mapManualCodeApiErrorToKey(raw: string, status: number): string {
  const lower = raw.trim().toLowerCase();
  if (lower.includes("empty code")) return "prov.manualErrorEmpty";
  if (lower.includes("code too large") || lower.includes("input too long") || status === 413) return "prov.manualErrorTooLarge";
  if (lower.includes("no login") || lower.includes("no login in progress")) return "prov.manualErrorNoLogin";
  if (lower.includes("stale login")) return "prov.manualErrorStale";
  if (lower.includes("no authorization code")) return "prov.manualErrorNoCode";
  if (lower.includes("missing the state")) return "prov.manualErrorMissingState";
  if (lower.includes("state mismatch")) return "prov.manualErrorStateMismatch";
  if (status >= 500) return "prov.networkError";
  return "prov.manualErrorInvalid";
}

type AccountSet = { activeAccountId: string | null; accounts: OAuthAccount[] };

export interface OAuthHook {
  cancelLoginOAuth: (provider: string) => Promise<void>;
  loginOAuth: (provider: string, addAccount?: boolean, accountId?: string) => Promise<void>;
  logoutOAuth: (provider: string) => Promise<void>;
  submitManualCode: (provider: string, input: string) => Promise<"submitted" | "cancelled">;
}

export function useProvidersOAuth({
  apiBase,
  t,
  aliveRef,
  accountSets,
  setAccountSets,
  setBusy,
  setStatus,
  setLoginInfo,
  setOauthStatus,
  notify,
  fetchConfig,
  fetchOauth,
  fetchAccountSets,
  fetchProviderQuotas,
  bumpModelsRefresh,
  onLoginSettled,
}: {
  apiBase: string;
  t: TFn;
  aliveRef: React.MutableRefObject<boolean>;
  accountSets: Record<string, AccountSet>;
  setAccountSets: React.Dispatch<React.SetStateAction<Record<string, AccountSet>>>;
  setBusy: React.Dispatch<React.SetStateAction<string | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoginInfo: React.Dispatch<React.SetStateAction<{ provider: string; url?: string; instructions?: string; deviceCode?: string; attemptId?: string } | null>>;
  setOauthStatus: React.Dispatch<React.SetStateAction<Record<string, OAuthStatus>>>;
  notify: (msg: string, ok: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchAccountSets: (providers: string[]) => Promise<unknown>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  bumpModelsRefresh: () => void;
  /** Select the provider and open Accounts after a successful login. */
  onLoginSettled?: (provider: string) => void;
}) {
  const oauthLoginGenerationRef = useRef<Map<string, number> | null>(null);
  if (oauthLoginGenerationRef.current === null) oauthLoginGenerationRef.current = new Map();
  const oauthAttemptIdRef = useRef<Map<string, string> | null>(null);
  if (oauthAttemptIdRef.current === null) oauthAttemptIdRef.current = new Map();
  const manualAbortRef = useRef<Map<string, AbortController> | null>(null);
  if (manualAbortRef.current === null) manualAbortRef.current = new Map();

  const bumpLoginGeneration = useCallback((provider: string) => {
    const gen = (oauthLoginGenerationRef.current!.get(provider) ?? 0) + 1;
    oauthLoginGenerationRef.current!.set(provider, gen);
    oauthAttemptIdRef.current!.delete(provider);
    const ctrl = manualAbortRef.current!.get(provider);
    if (ctrl) { ctrl.abort(); manualAbortRef.current!.delete(provider); }
    return gen;
  }, []);

  const cancelLoginOAuth = useCallback(async (provider: string) => {
    const gen = bumpLoginGeneration(provider);
    try {
      await fetch(`${apiBase}/api/oauth/login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
    } catch { /* ignore */ }
    if (!aliveRef.current) return;
    if (oauthLoginGenerationRef.current!.get(provider) === gen) {
      setBusy(current => current === provider ? null : current);
      setLoginInfo(current => current?.provider === provider ? null : current);
    }
    notify(t("prov.loginCancelled", { provider: oauthLabel(provider) }), false);
  }, [aliveRef, apiBase, bumpLoginGeneration, notify, setBusy, setLoginInfo, t]);

  const loginOAuth = async (provider: string, addAccount = false, accountId?: string) => {
    const generation = bumpLoginGeneration(provider);
    const reauthTargetId = accountId?.trim() || undefined;
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          ...(addAccount || reauthTargetId ? { addAccount: true } : {}),
          ...(reauthTargetId ? { accountId: reauthTargetId, reauth: true } : {}),
        }),
      });
      if (oauthLoginGenerationRef.current!.get(provider) !== generation || !aliveRef.current) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false);
        return;
      }
      const data = await res.json() as { url?: string; instructions?: string; deviceCode?: string; attemptId?: string };
      if (data.attemptId && typeof data.attemptId === "string") {
        oauthAttemptIdRef.current!.set(provider, data.attemptId);
      }
      if (data.url || data.instructions || data.deviceCode) {
        setLoginInfo({ provider, url: data.url, instructions: data.instructions, deviceCode: data.deviceCode, attemptId: data.attemptId });
      }
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      let finished = false;
      for (let i = 0; i < 150 && aliveRef.current && oauthLoginGenerationRef.current!.get(provider) === generation; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (oauthLoginGenerationRef.current!.get(provider) !== generation || !aliveRef.current) return;
        const sRes = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).catch(() => null);
        const s: (OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }) | null = sRes
          ? ((await readJsonIfOk<OAuthStatus & { accounts?: OAuthAccount[]; activeAccountId?: string | null }>(sRes)) ?? null)
          : null;
        if (!s) continue;
        if (s.error) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const cancelled = /cancel/i.test(s.error);
          notify(
            cancelled
              ? t("prov.loginCancelled", { provider: oauthLabel(provider) })
              : t("prov.loginError", { provider: oauthLabel(provider), error: s.error }),
            false,
          );
          setLoginInfo(null);
          finished = true;
          break;
        }
        const statusCount = s.accounts?.length ?? 0;
        const completed = addAccount || reauthTargetId
          ? (statusCount > baselineCount || s.done === true)
          : (s.loggedIn || s.done === true);
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const target = reauthTargetId
            ? s.accounts?.find(a => a.id === reauthTargetId)
            : s.accounts?.find(a => a.active) ?? s.accounts?.find(a => a.id === s.activeAccountId);
          if (reauthTargetId && !target) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthAccountMissing") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          if (target?.needsReauth) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthIdentityMismatch") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          // Seed the account list from the status poll immediately so Accounts does not
          // briefly render empty while the follow-up /api/oauth/accounts round-trip runs.
          if (s.accounts) {
            const activeFromRow = s.accounts.find(a => a.active)?.id ?? null;
            setAccountSets(current => ({
              ...current,
              [provider]: {
                activeAccountId: s.activeAccountId ?? activeFromRow,
                accounts: s.accounts!,
              },
            }));
          }
          setLoginInfo(null);
          onLoginSettled?.(provider);
          const knownProviders = Object.keys(accountSets);
          const knownSet = new Set(knownProviders);
          await fetchAccountSets(knownSet.has(provider) ? knownProviders : [...knownProviders, provider]);
          if (!aliveRef.current || oauthLoginGenerationRef.current!.get(provider) !== generation) return;
          const sameIdentityAdd = addAccount && !reauthTargetId && statusCount <= baselineCount;
          if (sameIdentityAdd) {
            notify(t("prov.loginSameAccount", { provider: oauthLabel(provider) }), false);
          } else {
            notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          }
          void fetchConfig();
          void fetchProviderQuotas(true);
          bumpModelsRefresh();
          finished = true;
          break;
        }
      }
      if (!finished && oauthLoginGenerationRef.current!.get(provider) === generation && aliveRef.current) {
        await fetch(`${apiBase}/api/oauth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        }).catch(() => {});
        notify(t("prov.loginTimeout", { provider: oauthLabel(provider) }), false);
        setLoginInfo(null);
      }
    } catch {
      if (oauthLoginGenerationRef.current!.get(provider) === generation) {
        notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
      }
    } finally {
      if (aliveRef.current && oauthLoginGenerationRef.current!.get(provider) === generation) setBusy(null);
    }
  };

  const logoutOAuth = async (provider: string) => {
    // Invalidate any in-flight login poll so a late completion cannot reseed accounts.
    bumpLoginGeneration(provider);
    setBusy(current => current === provider ? null : current);
    setLoginInfo(current => current?.provider === provider ? null : current);
    try {
      const res = await fetch(`${apiBase}/api/oauth/logout?provider=${encodeURIComponent(provider)}`, { method: "POST" });
      if (!res.ok) {
        notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
        return;
      }
      await Promise.all([
        fetchAccountSets([provider]),
        fetchOauth(),
        fetchConfig(),
        fetchProviderQuotas(true),
      ]);
      bumpModelsRefresh();
      notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    } catch {
      notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
    }
  };

  const submitManualCode = async (provider: string, input: string): Promise<"submitted" | "cancelled"> => {
    const attemptId = oauthAttemptIdRef.current!.get(provider);
    const controller = new AbortController();
    const prev = manualAbortRef.current!.get(provider);
    if (prev) prev.abort();
    manualAbortRef.current!.set(provider, controller);
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, input, attemptId }),
        signal: controller.signal,
      });
      if (!aliveRef.current) return "cancelled";
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        const raw = data.error || "";
        const key = mapManualCodeApiErrorToKey(raw, res.status);
        throw new SafeManualCodeError(t(key as never), { cause: new Error(data.error || String(res.status)) } as ErrorOptions);
      }
      return "submitted";
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return "cancelled";
      if (aliveRef.current) {
        if (error instanceof SafeManualCodeError && error.message) throw error;
        // Every other rejection (including fetch errors that happen to carry a cause) is transport.
        throw new Error(t("prov.networkError" as never), { cause: error });
      }
      return "cancelled";
    } finally {
      if (manualAbortRef.current!.get(provider) === controller) manualAbortRef.current!.delete(provider);
    }
  };

  return { cancelLoginOAuth, loginOAuth, logoutOAuth, submitManualCode };
}
