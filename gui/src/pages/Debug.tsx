import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import { IconRefresh } from "../icons";
import { Switch } from "../ui";

interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  claude: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage" | "injection" | "claude", boolean>>;
  env: Record<"debug" | "usage" | "injection" | "claude", boolean>;
}

interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

interface ClaudeInboundEntry {
  at: number;
  endpoint: string;
  model: string;
  resolvedModel?: string;
  stream?: boolean;
  maxTokens?: number;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  outputConfigEffort?: string;
  metadataKeys?: string[];
  hasMetadataUserId: boolean;
  hasSystem: boolean;
  anthropicBeta?: string;
  userIdTag?: string;
  systemTag?: string;
}

type LogStream = "provider" | "usage" | "injection";

const STREAMS = ["provider", "usage", "injection"] as const;

function formatLogTime(at: number): string {
  return at > 0 ? `[${new Date(at).toLocaleTimeString()}] ` : "";
}

function formatClaudeInboundTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function isStreamEnabled(debug: DebugSettings | null, stream: LogStream): boolean {
  return stream === "provider" ? !!debug?.enabled : stream === "usage" ? !!debug?.usage : !!debug?.injection;
}

function isDebugFlagEnabled(debug: DebugSettings, flag: keyof DebugSettings["env"]): boolean {
  return flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : flag === "injection" ? debug.injection : debug.claude;
}

export default function Debug({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [debug, setDebug] = useState<DebugSettings | null>(null);
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [claudeEntries, setClaudeEntries] = useState<ClaudeInboundEntry[]>([]);
  const afterRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // TanStack Virtual returns unstable function identities; React Compiler skips this call.
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    // Rows are a rolling 2000-entry window: key by the server-assigned seq so
    // cached measurements track entry identity when the head is trimmed.
    getItemKey: index => entries[index]!.seq,
  });

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
    (candidate: LogStream): boolean => isStreamEnabled(debug, candidate),
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
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    }
  }, [entries, follow, lineVirtualizer]);

  useEffect(() => {
    if (!debug?.claude) {
      setClaudeEntries([]);
      return;
    }
    const fetchClaude = async () => {
      try {
        const res = await fetch(`${apiBase}/api/claude/inbound-debug`);
        if (res.ok) {
          const data = await res.json() as { entries?: ClaudeInboundEntry[] };
          setClaudeEntries(Array.isArray(data.entries) ? data.entries : []);
        }
      } catch { /* ignore */ }
    };
    void fetchClaude();
    const interval = setInterval(() => void fetchClaude(), 2000);
    return () => clearInterval(interval);
  }, [apiBase, debug?.claude]);

  const setDebugFlag = async (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => {
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
          <label className="muted text-control" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
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
              {(["debug", "usage", "injection", "claude"] as const).map(flag => {
                const checked = isDebugFlagEnabled(debug, flag);
                return (
                  <div key={flag} style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 220 }}>
                    <Switch
                      on={checked}
                      disabled={debugBusy}
                      label={t(`debug.${flag}`)}
                      onClick={() => void setDebugFlag(flag, !checked)}
                    />
                    <span className="text-control">{t(`debug.${flag}`)}</span>
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

      {debug?.claude && (
        <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
          <div className="font-semibold" style={{ marginBottom: 4 }}>{t("debug.claudeInbound.title")}</div>
          <div className="muted text-control" style={{ marginBottom: 10 }}>{t("debug.claudeInbound.sub")}</div>
          {claudeEntries.length === 0 ? (
            <div className="muted text-control">{t("debug.claudeInbound.empty")}</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="table text-label">
                <thead>
                  <tr>
                    <th>{t("debug.claudeInbound.time")}</th>
                    <th>{t("debug.claudeInbound.endpoint")}</th>
                    <th>{t("debug.claudeInbound.model")}</th>
                    {/* Protocol field names from Claude inbound capture — not prose. */}
                    <th>thinking</th>
                    <th>effort</th>
                    <th>beta</th>
                    <th>metadata</th>
                    <th>system</th>
                  </tr>
                </thead>
                <tbody>
                  {claudeEntries.map((entry, i) => (
                    <tr key={`${entry.at}-${i}`}>
                      <td className="muted mono">{formatClaudeInboundTime(entry.at)}</td>
                      <td className="mono">{entry.endpoint}</td>
                      <td className="mono" title={entry.resolvedModel}>
                        {entry.model}
                        {entry.resolvedModel && entry.resolvedModel !== entry.model && (
                          <span className="muted"> → {entry.resolvedModel}</span>
                        )}
                      </td>
                      <td className="mono">
                        {entry.thinkingType ?? "-"}
                        {entry.thinkingBudgetTokens !== undefined && <span className="muted"> ({entry.thinkingBudgetTokens})</span>}
                      </td>
                      <td className="mono">{entry.outputConfigEffort ?? "-"}</td>
                      <td className="mono" title={entry.anthropicBeta} style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.anthropicBeta ?? "-"}</td>
                      <td className="mono" title={entry.metadataKeys?.join(", ")}>
                        {entry.hasMetadataUserId ? `user_id ${entry.userIdTag ?? ""}` : t("debug.claudeInbound.none")}
                      </td>
                      <td className="mono">{entry.hasSystem ? entry.systemTag ?? "yes" : t("debug.claudeInbound.none")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {debug && !streamEnabled ? (
        <div className="empty">
          <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.emptyTitle")}</div>
          <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t("debug.empty")}</div>
        </div>
      ) : debug && streamEnabled && entries.length === 0 ? (
        <div className="empty">
          <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.noLinesTitle")}</div>
          <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t(`debug.noLines.${stream}`)}</div>
        </div>
      ) : debug && streamEnabled ? (
        <div
          ref={scrollContainerRef}
          className="log-detail-json"
          style={{ maxHeight: "calc(100vh - 280px)", overflow: "auto" }}
        >
          <div
            style={{
              position: "relative",
              height: lineVirtualizer.getTotalSize(),
              width: "100%",
            }}
          >
            {lineVirtualizer.getVirtualItems().map(virtualRow => (
              <div
                key={virtualRow.key}
                ref={lineVirtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {`${formatLogTime(entries[virtualRow.index]!.at)}${entries[virtualRow.index]!.line}`}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
