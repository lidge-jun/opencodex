import { useCallback, useEffect, useRef, useState } from "react";
import { IconRefresh } from "../icons";
import { type TFn, useI18n } from "../i18n/shared";
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

function deriveCodexRuntimeNotice(
  runtime: CodexRuntimeSettings | undefined,
  t: TFn,
): { warning: string | null; fix: string | null } {
  if (!runtime) return { warning: null, fix: null };
  const clampActive = Boolean(runtime.catalogClamp?.active);
  const newer = Boolean(runtime.newerAvailable);
  const version = (clampActive
    ? runtime.catalogClamp?.runtimeVersion
    : runtime.version) ?? runtime.version ?? "unknown";
  const efforts = (runtime.catalogClamp?.removedEfforts ?? []).join(", ");
  if (clampActive) {
    return {
      warning: efforts
        ? t("startup.codexRuntime.clampHiddenWithEfforts", { version, efforts })
        : t("startup.codexRuntime.clampHidden", { version }),
      fix: newer ? "ocx doctor --fix-codex-runtime && ocx sync" : "ocx sync",
    };
  }
  if (newer) {
    return {
      warning: t("startup.codexRuntime.olderBinary", { version }),
      fix: "ocx doctor --fix-codex-runtime && ocx sync",
    };
  }
  return { warning: null, fix: null };
}

export default function Startup({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<StartupHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [tray, setTray] = useState<TrayStatusData | null>(null);
  const [trayLoading, setTrayLoading] = useState(true);
  const [trayBusy, setTrayBusy] = useState(false);
  const [trayError, setTrayError] = useState(false);
  const [installBusy, setInstallBusy] = useState<StartupInstallAction | null>(null);
  const [installResult, setInstallResult] = useState<{ kind: "success" | "error"; action: StartupInstallAction; detail?: string } | null>(null);
  const [codexRuntimeWarning, setCodexRuntimeWarning] = useState<string | null>(null);
  const [codexRuntimeFix, setCodexRuntimeFix] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setTrayLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/startup-health`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const next = await res.json() as StartupHealthData;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;

      // Load settings + tray in parallel, then commit once so the page never paints
      // without the runtime notice / tray actions (avoids layout shift).
      const settingsPromise = fetch(`${apiBase}/api/settings`, { signal })
        .then(async (settingsRes) => {
          if (!settingsRes.ok) return null;
          return await settingsRes.json() as { codexRuntime?: CodexRuntimeSettings };
        })
        .catch(() => null);

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

      const notice = deriveCodexRuntimeNotice(settings?.codexRuntime, t);
      setData(next);
      setFailed(next.diagnosticStale);
      setCodexRuntimeWarning(notice.warning);
      setCodexRuntimeFix(notice.fix);
      if (next.platform === "win32") {
        setTray(trayResult.tray);
        setTrayError(trayResult.error);
      } else {
        setTray(null);
        setTrayError(false);
      }
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setFailed(true);
      setTray(null);
      setTrayError(true);
      setCodexRuntimeWarning(null);
      setCodexRuntimeFix(null);
    } finally {
      if (generation === loadGenerationRef.current) {
        setTrayLoading(false);
        setLoading(false);
      }
    }
  }, [apiBase, t]);

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

  const runInstallAction = async (action: StartupInstallAction) => {
    setInstallBusy(action);
    setInstallResult(null);
    try {
      const res = await fetch(`${apiBase}/api/startup-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "installation failed");
      }
      setInstallResult({ kind: "success", action });
      await refresh();
    } catch (error) {
      setInstallResult({ kind: "error", action, detail: error instanceof Error ? error.message : String(error) });
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
          {failed && <div className="notice notice-warn" role="alert">{t("startup.staleData")}</div>}
          {codexRuntimeWarning && (
            <div className="notice notice-warn startup-runtime-notice" role="status">
              <p className="startup-runtime-notice__text">{codexRuntimeWarning}</p>
              {codexRuntimeFix && (
                <div className="startup-runtime-notice__fix">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyCommand(codexRuntimeFix)}>
                    {copied === codexRuntimeFix ? t("startup.copied") : t("startup.copy")}
                  </button>
                  <code>{codexRuntimeFix}</code>
                </div>
              )}
            </div>
          )}
          <StartupHeroSection failed={failed} data={data} />
          <StartupDetailsSection
            data={data}
            failed={failed}
            installBusy={installBusy}
            installResult={installResult}
            onInstall={(action) => { void runInstallAction(action); }}
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
