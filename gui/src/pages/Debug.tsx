import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { setClientResourceData, useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { DebugClaudeInboundPanel } from "./debug-claude-inbound-panel";
import { DebugLogViewer } from "./debug-log-viewer";
import { DebugPageHeader, DebugSettingsPanel } from "./debug-settings-panel";
import {
  DEBUG_STREAMS,
  type DebugSettings,
  type LogStream,
  isStreamEnabled,
} from "./debug-shared";

function debugSettingsKey(apiBase: string): string {
  return `debug-settings:${apiBase}`;
}

export default function Debug({ apiBase, embedded, active = true }: { apiBase: string; embedded?: boolean; active?: boolean }) {
  const { t } = useI18n();
  const settingsCacheKey = `ocx.debug.settings.v1:${apiBase}`;
  const cachedSettings = readSessionListCache<DebugSettings>(settingsCacheKey);
  const [debugBusy, setDebugBusy] = useState(false);
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<import("./debug-shared").DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationQueueRef = useRef<Promise<void> | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Only reset the log viewer when the active stream identity changes — not when
  // unrelated debug flags toggle (those used to rebuild fetchLogs and storm GETs).
  const streamIdentityRef = useRef<string | null>(null);

  const debugPoll = useKeyedClientResource(
    debugSettingsKey(apiBase),
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/debug`, { signal });
      if (!res.ok) return null;
      const next = await res.json() as DebugSettings;
      writeSessionListCache(settingsCacheKey, next);
      return next;
    },
    { pollMs: 2000, enabled: active },
  );
  const debug = debugPoll.data ?? cachedSettings ?? null;

  const claudePoll = useKeyedClientResource(
    `debug-claude-inbound:${apiBase}`,
    [apiBase, debug?.claude],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/claude/inbound-debug`, { signal });
      if (!res.ok) return [] as import("./debug-shared").ClaudeInboundEntry[];
      const data = await res.json() as { entries?: import("./debug-shared").ClaudeInboundEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    },
    { pollMs: 2000, enabled: active && !!debug?.claude },
  );
  const claudeEntries = claudePoll.data ?? [];

  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    getItemKey: index => entries[index]!.seq,
  });

  const streamIsOn = useCallback(
    (candidate: LogStream): boolean => isStreamEnabled(debug, candidate),
    [debug],
  );

  useEffect(() => {
    if (!debug || streamIsOn(stream)) return;
    const next = DEBUG_STREAMS.find(streamIsOn);
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
      const next = await res.json() as import("./debug-shared").DebugLogEntry[];
      if (next.length === 0) return;
      setEntries(prev => (initial ? next : [...prev, ...next]).slice(-2000));
      afterRef.current = next[next.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled]);

  useEffect(() => {
    if (!active) return;
    const identity = `${stream}:${streamEnabled}`;
    const changed = streamIdentityRef.current !== identity;
    streamIdentityRef.current = identity;
    if (!changed && entries.length > 0) return;
    afterRef.current = 0;
    const timeout = window.setTimeout(() => {
      if (changed) setEntries([]);
      void fetchLogs(true);
    }, 0);
    return () => window.clearTimeout(timeout);
    // Intentionally omit fetchLogs/entries — identity gate prevents switch storms.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stream identity only
  }, [active, stream, streamEnabled]);

  const pollLogs = useEffectEvent((initial: boolean) => {
    void fetchLogs(initial);
  });

  useEffect(() => {
    if (!active || !follow || !streamEnabled) return;
    const interval = setInterval(() => pollLogs(false), 1000);
    return () => clearInterval(interval);
  }, [active, follow, streamEnabled]);

  useEffect(() => {
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, follow, lineVirtualizer]);

  const runDebugMutation = async (body: Record<string, unknown>) => {
    const generation = ++mutationGenerationRef.current;
    setDebugBusy(true);
    // Serialize PUTs so server writes follow user-action order. Latest-wins
    // response filtering alone cannot prevent out-of-order server state.
    const run = async () => {
      try {
        const res = await fetch(`${apiBase}/api/debug`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const next = await res.json() as DebugSettings;
        if (generation !== mutationGenerationRef.current) return;
        writeSessionListCache(settingsCacheKey, next);
        setClientResourceData(debugSettingsKey(apiBase), next);
      } catch { /* ignore */ }
    };
    const previous = mutationQueueRef.current ?? Promise.resolve();
    const queued = previous.then(run, run);
    mutationQueueRef.current = queued.then(() => undefined, () => undefined);
    try {
      await queued;
    } finally {
      if (generation === mutationGenerationRef.current) setDebugBusy(false);
    }
  };

  const setDebugFlag = async (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => {
    await runDebugMutation({ [flag]: enabled });
  };

  const resetDebug = async () => {
    await runDebugMutation({ reset: true });
  };

  return (
    <>
      <DebugPageHeader
        embedded={embedded}
        refreshing={refreshing}
        streamEnabled={streamEnabled}
        follow={follow}
        onRefresh={() => void fetchLogs(true)}
        onFollowChange={setFollow}
      />

      {!debug ? (
        <div className="empty">{t("debug.loading")}</div>
      ) : (
        <DebugSettingsPanel
          debug={debug}
          debugBusy={debugBusy}
          stream={stream}
          onSetFlag={(flag, enabled) => { void setDebugFlag(flag, enabled); }}
          onReset={() => { void resetDebug(); }}
          onStreamChange={setStream}
        />
      )}

      {debug?.claude && <DebugClaudeInboundPanel entries={claudeEntries} />}

      <DebugLogViewer
        debug={!!debug}
        stream={stream}
        streamEnabled={streamEnabled}
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        lineVirtualizer={lineVirtualizer}
      />
    </>
  );
}
