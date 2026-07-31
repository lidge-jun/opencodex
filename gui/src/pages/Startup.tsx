import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconRefresh } from "../icons";
import { type TFn, useI18n } from "../i18n/shared";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { EmptyState } from "../ui";
import {
  StartupDetailsSection,
  StartupHeroSection,
  StartupRecoverySection,
  StartupTraySection,
} from "./startup-sections";
import {
  isTrayStatusData,
  type StartupHealthData,
  type StartupInstallAction,
  type TrayStatusData,
} from "./startup-shared";

type CodexRuntimeSettings = {
  version?: string | null;
  newerAvailable?: { path?: string; version?: string | null } | null;
  catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
};

type StartupPageCache = {
  data: StartupHealthData;
  warning: string | null;
  fix: string | null;
  tray: TrayStatusData | null;
};

const STARTUP_PAGE_CACHE_PREFIX = "ocx.startup.page.v1:";

function shellChain(commands: string[], platform: string | undefined): string {
  // Windows PowerShell 5.x rejects bash `&&`; `;` works in PowerShell and cmd.
  const sep = platform === "win32" ? "; " : " && ";
  return commands.join(sep);
}

function deriveCodexRuntimeNotice(
  runtime: CodexRuntimeSettings | undefined,
  t: TFn,
  platform?: string,
): { warning: string | null; fix: string | null } {
  if (!runtime) return { warning: null, fix: null };
  const clampActive = Boolean(runtime.catalogClamp?.active);
  const newer = Boolean(runtime.newerAvailable);
  const version = (clampActive
    ? runtime.catalogClamp?.runtimeVersion
    : runtime.version) ?? runtime.version ?? "unknown";
  const efforts = (runtime.catalogClamp?.removedEfforts ?? []).join(", ");
  const doctorSync = shellChain(["ocx doctor --fix-codex-runtime", "ocx sync"], platform);
  if (clampActive) {
    return {
      warning: efforts
        ? t("startup.codexRuntime.clampHiddenWithEfforts", { version, efforts })
        : t("startup.codexRuntime.clampHidden", { version }),
      fix: newer ? doctorSync : "ocx sync",
    };
  }
  if (newer) {
    return {
      warning: t("startup.codexRuntime.olderBinary", { version }),
      fix: doctorSync,
    };
  }
  return { warning: null, fix: null };
}

export default function Startup({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const cacheKey = `${STARTUP_PAGE_CACHE_PREFIX}${apiBase}`;
  const cached = useMemo(() => readSessionListCache<StartupPageCache>(cacheKey), [cacheKey]);

  const [data, setData] = useState<StartupHealthData | null>(() => cached?.data ?? null);
  const [loading, setLoading] = useState(() => !cached?.data);
  const [failed, setFailed] = useState(() => Boolean(cached?.data?.diagnosticStale));
  const [copied, setCopied] = useState<string | null>(null);
  const [tray, setTray] = useState<TrayStatusData | null>(() => cached?.tray ?? null);
  const [trayLoading, setTrayLoading] = useState(() => !cached?.data);
  const [trayBusy, setTrayBusy] = useState(false);
  const [trayError, setTrayError] = useState(false);
  const [installBusy, setInstallBusy] = useState<StartupInstallAction | null>(null);
  const [installResult, setInstallResult] = useState<{ kind: "success" | "error"; action: StartupInstallAction; repair?: boolean; detail?: string } | null>(null);
  const [codexRuntimeWarning, setCodexRuntimeWarning] = useState<string | null>(() => cached?.warning ?? null);
  const [codexRuntimeFix, setCodexRuntimeFix] = useState<string | null>(() => cached?.fix ?? null);
  /** True while settings (runtime notice) are still in flight — reserves notice slot height. */
  const [runtimeNoticePending, setRuntimeNoticePending] = useState(() => !cached?.data);
  const loadGenerationRef = useRef(0);
  const paintedRef = useRef(Boolean(cached?.data));

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    const keepSecondary = paintedRef.current;
    setLoading(true);
    // Keep prior notice/tray visible on revalidation; only reserve empty slots on first paint.
    if (!keepSecondary) {
      setTrayLoading(true);
      setRuntimeNoticePending(true);
    }
    try {
      // Kick settings off immediately so it overlaps the health round-trip.
      const settingsPromise = fetch(`${apiBase}/api/settings`, { signal })
        .then(async (settingsRes) => {
          if (!settingsRes.ok) return null;
          return await settingsRes.json() as { codexRuntime?: CodexRuntimeSettings };
        })
        .catch(() => null);

      const res = await fetch(`${apiBase}/api/startup-health`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const next = await res.json() as StartupHealthData;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;

      // Paint hero/details/recovery as soon as health arrives.
      setData(next);
      paintedRef.current = true;
      setFailed(next.diagnosticStale);
      setLoading(false);

      const trayPromise = next.platform === "win32"
        ? fetch(`${apiBase}/api/windows-tray`, { signal })
          .then(async (trayRes) => {
            if (!trayRes.ok) throw new Error("tray status failed");
            const trayNext = await trayRes.json() as unknown;
            if (!isTrayStatusData(trayNext)) throw new Error("invalid tray status");
            return { tray: trayNext, error: false as const };
          })
          .catch(() => ({ tray: null, error: true as const }))
        : Promise.resolve({ tray: null, error: false as const });

      const [settings, trayResult] = await Promise.all([settingsPromise, trayPromise]);
      if (signal?.aborted || generation !== loadGenerationRef.current) return;

      const nextTray = next.platform === "win32" ? trayResult.tray : null;
      if (next.platform === "win32") {
        setTray(nextTray);
        setTrayError(trayResult.error);
      } else {
        setTray(null);
        setTrayError(false);
      }
      setTrayLoading(false);
      setRuntimeNoticePending(false);

      if (settings) {
        const notice = deriveCodexRuntimeNotice(settings.codexRuntime, t, next.platform);
        setCodexRuntimeWarning(notice.warning);
        setCodexRuntimeFix(notice.fix);
        writeSessionListCache(cacheKey, {
          data: next,
          warning: notice.warning,
          fix: notice.fix,
          tray: nextTray,
        } satisfies StartupPageCache);
      } else {
        // Settings fetch failure: keep the last-good runtime notice in UI + cache.
        const prev = readSessionListCache<StartupPageCache>(cacheKey);
        writeSessionListCache(cacheKey, {
          data: next,
          warning: prev?.warning ?? null,
          fix: prev?.fix ?? null,
          tray: nextTray,
        } satisfies StartupPageCache);
      }
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setFailed(true);
      if (!keepSecondary) {
        setTray(null);
        setTrayError(true);
        setCodexRuntimeWarning(null);
        setCodexRuntimeFix(null);
      }
      setRuntimeNoticePending(false);
      setTrayLoading(false);
      setLoading(false);
    }
  }, [apiBase, cacheKey, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      // Invalidate before abort so a superseded request's finally cannot clear
      // loading in the gap before the deferred replacement increments generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (!data?.diagnosticStale) return;
    const timer = window.setTimeout(() => { void refresh(); }, 2000);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      window.setTimeout(() => setCopied(current => current === command ? null : current), 1600);
    } catch {
      setCopied(null);
    }
  };

  const runTrayAction = async (action: "install" | "start" | "stop" | "uninstall") => {
    setTrayBusy(true);
    setTrayError(false);
    try {
      const res = await fetch(`${apiBase}/api/windows-tray`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error("tray action failed");
      const body = await res.json() as { status: TrayStatusData };
      if (!isTrayStatusData(body.status)) throw new Error("invalid tray action status");
      setTray(body.status);
      setTrayError(false);
    } catch {
      setTray(null);
      setTrayError(true);
    } finally {
      setTrayBusy(false);
    }
  };

  const runInstallAction = async (action: StartupInstallAction, opts?: { repair?: boolean }) => {
    setInstallBusy(action);
    setInstallResult(null);
    try {
      const res = await fetch(`${apiBase}/api/startup-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, repair: opts?.repair === true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "installation failed");
      }
      setInstallResult({ kind: "success", action, repair: opts?.repair === true });
      await refresh();
    } catch (error) {
      setInstallResult({ kind: "error", action, repair: opts?.repair === true, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstallBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{t("startup.title")}</h2>
          <p className="page-sub startup-page-sub">{t("startup.subtitle")}</p>
        </div>
        <div className="startup-page-head-actions">
          <a className="btn btn-ghost btn-sm" href="#dashboard">{t("startup.backToDashboard")}</a>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh /> {t("startup.refresh")}
          </button>
        </div>
      </div>

      {loading && !data ? (
        <EmptyState title={t("startup.loading")} />
      ) : failed && !data ? (
        <EmptyState title={t("startup.error")} />
      ) : data ? (
        <>
          {failed && (
            <div className="notice notice-warn startup-page-notice" role="alert">
              {t("startup.staleData")}
            </div>
          )}
          {(runtimeNoticePending || codexRuntimeWarning) && (
            <div
              className={`startup-runtime-notice-slot${runtimeNoticePending && !codexRuntimeWarning ? " startup-runtime-notice-slot--pending" : ""}`}
              aria-hidden={runtimeNoticePending && !codexRuntimeWarning ? true : undefined}
            >
              {codexRuntimeWarning && (
                <div className="notice notice-warn startup-page-notice startup-runtime-notice" role="status">
                  <p className="startup-runtime-notice__text">{codexRuntimeWarning}</p>
                  {codexRuntimeFix && (
                    <div className="startup-runtime-notice__fix">
                      <code>{codexRuntimeFix}</code>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(codexRuntimeFix)}>
                        {copied === codexRuntimeFix ? t("startup.copied") : t("startup.copy")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <StartupHeroSection failed={failed} data={data} />
          <StartupDetailsSection
            data={data}
            failed={failed}
            loading={loading}
            installBusy={installBusy}
            installResult={installResult}
            onInstall={(action, opts) => { void runInstallAction(action, opts); }}
          />
          {data.platform === "win32" && (
            <StartupTraySection
              tray={tray}
              trayLoading={trayLoading}
              trayError={trayError}
              trayBusy={trayBusy}
              onTrayAction={(action) => { void runTrayAction(action); }}
            />
          )}
          <StartupRecoverySection data={data} copied={copied} onCopy={(command) => { void copyCommand(command); }} />
        </>
      ) : null}
    </>
  );
}
