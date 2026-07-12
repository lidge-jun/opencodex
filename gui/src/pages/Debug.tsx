import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconRefresh } from "../icons";
import { Switch } from "../ui";

interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage" | "injection", boolean>>;
  env: Record<"debug" | "usage" | "injection", boolean>;
}

interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

type LogStream = "provider" | "usage" | "injection";

const STREAMS = ["provider", "usage", "injection"] as const;

const formatLogTime = (at: number): string =>
  at > 0 ? `[${new Date(at).toLocaleTimeString()}] ` : "";

export default function Debug({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [debug, setDebug] = useState<DebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const fetchDebug = async () => {
      try {
        const res = await fetch(`${apiBase}/api/debug`);
        if (res.ok) setDebug(await res.json());
      } catch { /* ignore */ }
    };
    void fetchDebug();
    const interval = setInterval(() => void fetchDebug(), 2000);
    return () => clearInterval(interval);
  }, [apiBase]);

  const streamIsOn = useCallback(
    (s: LogStream): boolean =>
      s === "provider" ? !!debug?.enabled : s === "usage" ? !!debug?.usage : !!debug?.injection,
    [debug],
  );

  useEffect(() => {
    if (!debug || streamIsOn(stream)) return;
    const next = STREAMS.find(streamIsOn);
    if (!next) return;
    const timeout = window.setTimeout(() => setStream(next), 0);
    return () => window.clearTimeout(timeout);
  }, [debug, stream, streamIsOn]);

  const streamEnabled = streamIsOn(stream);
  const logsPath =
    stream === "provider"
      ? `${apiBase}/api/debug/logs`
      : stream === "usage"
        ? `${apiBase}/api/debug/usage-logs`
        : `${apiBase}/api/debug/injection-logs`;

  const fetchLogs = useCallback(async (initial: boolean) => {
    if (!streamEnabled) {
      setEntries([]);
      afterRef.current = 0;
      return;
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (!initial && afterRef.current > 0) params.set("after", String(afterRef.current));
      const res = await fetch(`${logsPath}?${params}`);
      if (!res.ok) return;
      const next = await res.json() as DebugLogEntry[];
      if (next.length === 0) return;
      setEntries(prev => (initial ? next : [...prev, ...next]).slice(-2000));
      afterRef.current = next[next.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled]);

  useEffect(() => {
    afterRef.current = 0;
    const timeout = window.setTimeout(() => {
      setEntries([]);
      void fetchLogs(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [stream, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => void fetchLogs(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries, follow]);

  const setDebugFlag = async (flag: "debug" | "usage" | "injection", enabled: boolean) => {
    setDebugBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [flag]: enabled }),
      });
      if (res.ok) setDebug(await res.json());
    } catch { /* ignore */ } finally {
      setDebugBusy(false);
    }
  };

  const resetDebug = async () => {
    setDebugBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (res.ok) setDebug(await res.json());
    } catch { /* ignore */ } finally {
      setDebugBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t("debug.title")}</h2>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={refreshing || !streamEnabled}
            onClick={() => void fetchLogs(true)}
          >
            <IconRefresh /> {t("debug.refresh")}
          </button>
          <label className="muted" style={{ fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
            {t("debug.follow")}
          </label>
        </div>
      </div>
      <p className="page-sub">{t("debug.subtitle")}</p>

      {!debug ? (
        <div className="empty">{t("debug.loading")}</div>
      ) : (
        <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              {(["debug", "usage", "injection"] as const).map(flag => {
                const checked = flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : debug.injection;
                return (
                  <div key={flag} style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 220 }}>
                    <Switch
                      on={checked}
                      disabled={debugBusy}
                      label={t(`debug.${flag}`)}
                      onClick={() => void setDebugFlag(flag, !checked)}
                    />
                    <span style={{ fontSize: 13 }}>{t(`debug.${flag}`)}</span>
                  </div>
                );
              })}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={debugBusy} onClick={() => void resetDebug()}>
              {t("debug.reset")}
            </button>
          </div>

          {(debug.enabled || debug.usage || debug.injection) && (
            <div style={{ display: "inline-flex", gap: 6, marginTop: 12 }}>
              {debug.enabled && (
                <button
                  type="button"
                  className={`btn btn-sm${stream === "provider" ? " btn-primary" : " btn-ghost"}`}
                  onClick={() => setStream("provider")}
                >
                  {t("debug.streamProvider")}
                </button>
              )}
              {debug.usage && (
                <button
                  type="button"
                  className={`btn btn-sm${stream === "usage" ? " btn-primary" : " btn-ghost"}`}
                  onClick={() => setStream("usage")}
                >
                  {t("debug.streamUsage")}
                </button>
              )}
              {debug.injection && (
                <button
                  type="button"
                  className={`btn btn-sm${stream === "injection" ? " btn-primary" : " btn-ghost"}`}
                  onClick={() => setStream("injection")}
                >
                  {t("debug.streamInjection")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {debug && !streamEnabled ? (
        <div className="empty">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("debug.emptyTitle")}</div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 560, marginInline: "auto" }}>{t("debug.empty")}</div>
        </div>
      ) : debug && streamEnabled && entries.length === 0 ? (
        <div className="empty">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("debug.noLinesTitle")}</div>
          <div className="muted" style={{ fontSize: 13, maxWidth: 560, marginInline: "auto" }}>{t(`debug.noLines.${stream}`)}</div>
        </div>
      ) : debug && streamEnabled ? (
        <pre ref={logRef} className="log-detail-json" style={{ maxHeight: "calc(100vh - 280px)" }}>
          {entries.map(entry => `${formatLogTime(entry.at)}${entry.line}`).join("\n")}
        </pre>
      ) : null}
    </>
  );
}
