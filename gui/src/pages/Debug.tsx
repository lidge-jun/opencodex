import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
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
type DebugFlag = "debug" | "usage" | "injection" | "claude";

const STREAMS = ["provider", "usage", "injection"] as const;

const formatLogTime = (at: number): string =>
  at > 0 ? `[${new Date(at).toLocaleTimeString()}] ` : "";

export default function Debug({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // TanStack Virtual returns unstable function identities; React Compiler skips this call.
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    getItemKey: index => entries[index]!.seq,
  });

  const { data: debug = null } = useQuery({
    queryKey: ["debug", apiBase],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/api/debug`);
      if (!res.ok) throw new Error("debug fetch failed");
      return res.json() as Promise<DebugSettings>;
    },
    refetchInterval: 2000,
    retry: false,
  });

  const { data: claudeInboundData } = useQuery({
    queryKey: ["claude-inbound-debug", apiBase],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/api/claude/inbound-debug`);
      if (!res.ok) throw new Error("claude inbound debug fetch failed");
      return res.json() as Promise<{ entries?: ClaudeInboundEntry[] }>;
    },
    enabled: !!debug?.claude,
    refetchInterval: 2000,
    retry: false,
  });
  const claudeEntries = debug?.claude
    ? (Array.isArray(claudeInboundData?.entries) ? claudeInboundData.entries : [])
    : [];

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

  const fetchLogsEvent = useEffectEvent((initial: boolean) => {
    void fetchLogs(initial);
  });

  useEffect(() => {
    afterRef.current = 0;
    const timeout = window.setTimeout(() => {
      setEntries([]);
      fetchLogsEvent(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [stream, streamEnabled]);

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => fetchLogsEvent(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled]);

  useEffect(() => {
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, follow, lineVirtualizer]);

  const setDebugFlag = async (flag: DebugFlag, enabled: boolean) => {
    setDebugBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [flag]: enabled }),
      });
      if (res.ok) queryClient.setQueryData(["debug", apiBase], await res.json());
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
      if (res.ok) queryClient.setQueryData(["debug", apiBase], await res.json());
    } catch { /* ignore */ } finally {
      setDebugBusy(false);
    }
  };

  return (
    <>
      <DebugPageHeader
        t={t}
        follow={follow}
        setFollow={setFollow}
        refreshing={refreshing}
        streamEnabled={streamEnabled}
        onRefresh={() => void fetchLogs(true)}
      />
      <p className="page-sub">{t("debug.subtitle")}</p>

      {!debug ? (
        <div className="empty">{t("debug.loading")}</div>
      ) : (
        <DebugFlagsPanel
          debug={debug}
          debugBusy={debugBusy}
          stream={stream}
          setStream={setStream}
          t={t}
          onSetFlag={setDebugFlag}
          onReset={resetDebug}
        />
      )}

      {debug?.claude && <DebugClaudeInboundPanel entries={claudeEntries} t={t} />}

      <DebugLogViewer
        debug={debug}
        stream={stream}
        streamEnabled={streamEnabled}
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        lineVirtualizer={lineVirtualizer}
        t={t}
      />
    </>
  );
}

function DebugPageHeader({
  t, follow, setFollow, refreshing, streamEnabled, onRefresh,
}: {
  t: TFn;
  follow: boolean;
  setFollow: Dispatch<SetStateAction<boolean>>;
  refreshing: boolean;
  streamEnabled: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="page-head">
      <h2>{t("debug.title")}</h2>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={refreshing || !streamEnabled} onClick={onRefresh}>
          <IconRefresh /> {t("debug.refresh")}
        </button>
        <label className="muted text-control" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} />
          {t("debug.follow")}
        </label>
      </div>
    </div>
  );
}

function DebugFlagsPanel({
  debug, debugBusy, stream, setStream, t, onSetFlag, onReset,
}: {
  debug: DebugSettings;
  debugBusy: boolean;
  stream: LogStream;
  setStream: Dispatch<SetStateAction<LogStream>>;
  t: TFn;
  onSetFlag: (flag: DebugFlag, enabled: boolean) => void;
  onReset: () => void;
}) {
  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          {(["debug", "usage", "injection", "claude"] as const).map(flag => {
            const checked = flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : flag === "injection" ? debug.injection : debug.claude;
            return (
              <div key={flag} style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 220 }}>
                <Switch on={checked} disabled={debugBusy} label={t(`debug.${flag}`)} onClick={() => void onSetFlag(flag, !checked)} />
                <span className="text-control">{t(`debug.${flag}`)}</span>
              </div>
            );
          })}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={debugBusy} onClick={() => void onReset()}>
          {t("debug.reset")}
        </button>
      </div>

      {(debug.enabled || debug.usage || debug.injection) && (
        <div style={{ display: "inline-flex", gap: 6, marginTop: 12 }}>
          {debug.enabled && (
            <button type="button" className={`btn btn-sm${stream === "provider" ? " btn-primary" : " btn-ghost"}`} onClick={() => setStream("provider")}>
              {t("debug.streamProvider")}
            </button>
          )}
          {debug.usage && (
            <button type="button" className={`btn btn-sm${stream === "usage" ? " btn-primary" : " btn-ghost"}`} onClick={() => setStream("usage")}>
              {t("debug.streamUsage")}
            </button>
          )}
          {debug.injection && (
            <button type="button" className={`btn btn-sm${stream === "injection" ? " btn-primary" : " btn-ghost"}`} onClick={() => setStream("injection")}>
              {t("debug.streamInjection")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DebugClaudeInboundPanel({ entries, t }: { entries: ClaudeInboundEntry[]; t: TFn }) {
  return (
    <div className="card" style={{ marginBottom: 16, padding: "12px 14px" }}>
      <div className="font-semibold" style={{ marginBottom: 4 }}>{t("debug.claudeInbound.title")}</div>
      <div className="muted text-control" style={{ marginBottom: 10 }}>{t("debug.claudeInbound.sub")}</div>
      {entries.length === 0 ? (
        <div className="muted text-control">{t("debug.claudeInbound.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table text-label">
            <thead>
              <tr>
                <th>{t("debug.claudeInbound.time")}</th>
                <th>{t("debug.claudeInbound.endpoint")}</th>
                <th>{t("debug.claudeInbound.model")}</th>
                <th>thinking</th>
                <th>effort</th>
                <th>beta</th>
                <th>metadata</th>
                <th>system</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={`${entry.at}-${entry.endpoint}-${entry.model}`}>
                  <td className="muted mono">{new Date(entry.at).toLocaleTimeString()}</td>
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
  );
}

function DebugLogViewer({
  debug, stream, streamEnabled, entries, scrollContainerRef, lineVirtualizer, t,
}: {
  debug: DebugSettings | null;
  stream: LogStream;
  streamEnabled: boolean;
  entries: DebugLogEntry[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  lineVirtualizer: Virtualizer<HTMLDivElement, Element>;
  t: TFn;
}) {
  if (debug && !streamEnabled) {
    return (
      <div className="empty">
        <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.emptyTitle")}</div>
        <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t("debug.empty")}</div>
      </div>
    );
  }
  if (debug && streamEnabled && entries.length === 0) {
    return (
      <div className="empty">
        <div className="font-semibold" style={{ marginBottom: 6 }}>{t("debug.noLinesTitle")}</div>
        <div className="muted text-control" style={{ maxWidth: 560, marginInline: "auto" }}>{t(`debug.noLines.${stream}`)}</div>
      </div>
    );
  }
  if (!debug || !streamEnabled) return null;

  return (
    <div ref={scrollContainerRef} className="log-detail-json" style={{ maxHeight: "calc(100vh - 280px)", overflow: "auto" }}>
      <div style={{ position: "relative", height: lineVirtualizer.getTotalSize(), width: "100%" }}>
        {lineVirtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.key}
            ref={lineVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
          >
            {`${formatLogTime(entries[virtualRow.index]!.at)}${entries[virtualRow.index]!.line}`}
          </div>
        ))}
      </div>
    </div>
  );
}
