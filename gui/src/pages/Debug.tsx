import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconRefresh } from "../icons";
import { Switch } from "../ui";

interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage", boolean>>;
  env: Record<"debug" | "usage", boolean>;
}

interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

type LogStream = "provider" | "usage";

export default function Debug({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [debug, setDebug] = useState<DebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [lines, setLines] = useState<string[]>([]);
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

  useEffect(() => {
    if (!debug) return;
    if (debug.enabled && stream === "usage" && !debug.usage) setStream("provider");
    if (debug.usage && stream === "provider" && !debug.enabled) setStream("usage");
  }, [debug, stream]);

  const streamEnabled = stream === "provider" ? !!debug?.enabled : !!debug?.usage;
  const logsPath = stream === "provider" ? `${apiBase}/api/debug/logs` : `${apiBase}/api/debug/usage-logs`;

  const fetchLogs = useCallback(async (initial: boolean) => {
    if (!streamEnabled) {
      setLines([]);
      afterRef.current = 0;
      return;
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (!initial && afterRef.current > 0) params.set("after", String(afterRef.current));
      const res = await fetch(`${logsPath}?${params}`);
      if (!res.ok) return;
      const entries = await res.json() as DebugLogEntry[];
      if (entries.length === 0) return;
      setLines(prev => initial
        ? entries.map(entry => entry.line)
        : [...prev, ...entries.map(entry => entry.line)].slice(-2000));
      afterRef.current = entries[entries.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled]);

  useEffect(() => {
    afterRef.current = 0;
    setLines([]);
    void fetchLogs(true);
  }, [stream, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => void fetchLogs(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled, fetchLogs]);

  useEffect(() => {
    if (!follow || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, follow]);

  const setDebugFlag = async (flag: "debug" | "usage", enabled: boolean) => {
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

      {debug && (
        <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              {(["debug", "usage"] as const).map(flag => {
                const checked = flag === "debug" ? debug.enabled : debug.usage;
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

          {(debug.enabled || debug.usage) && (
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
            </div>
          )}
        </div>
      )}

      {!streamEnabled ? (
        <div className="empty">{t("debug.empty")}</div>
      ) : lines.length === 0 ? (
        <div className="empty">{t("debug.noLines")}</div>
      ) : (
        <pre ref={logRef} className="log-detail-json" style={{ maxHeight: "calc(100vh - 280px)" }}>{lines.join("\n")}</pre>
      )}
    </>
  );
}
