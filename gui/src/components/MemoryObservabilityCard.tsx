import { useEffect, useState } from "react";
import { formatUptime } from "../formatUptime";
import { IconActivity } from "../icons";
import { useI18n, type Locale } from "../i18n/shared";

/**
 * Read-only Memory observability card. Polls GET /api/system/memory (the #314 WP3
 * service-process introspection surface) every 5s and renders scalar diagnostics
 * only: no sliders, no restart toggle, no PUT. A flat JS heap under a rising RSS
 * points at native runtime memory rather than an app-level leak; a rising
 * continuation-store total under a rising heap points at conversation retention.
 */

interface MemorySample {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
}

interface ResponseState {
  count: number;
  totalBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
}

interface SystemMemory {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  jscHeap: { heapSize: number; heapCapacity: number; objectCount: number } | null;
  /** Absent on older proxies whose /api/system/memory predates the continuation-store metrics. */
  responseState?: ResponseState;
  watchdog: { warnThresholdBytes: number; lastWarnAt: number | null; samples: MemorySample[] } | null;
}

/**
 * Render a byte count with a binary-scaled unit; non-finite/zero inputs render as "0 B".
 * The divisor is 1024, so the labels must be the binary ones (KiB/MiB/...). Labelling a
 * 1024-scaled value "KB" misreports it by ~2.4% per step, which is exactly the kind of drift a
 * memory diagnostic must not introduce. The number itself goes through the active locale so it
 * matches every other figure on this dashboard.
 */
function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: exp === 0 ? 0 : 1,
    maximumFractionDigits: exp === 0 ? 0 : 1,
  }).format(value);
  return `${formatted} ${units[exp]}`;
}

/** Render a millisecond age via the locale-aware uptime formatter; invalid/negative ages render as "—". */
function formatAge(ms: number, locale: Locale): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return formatUptime(ms / 1000, locale);
}

/** Derive RSS drift per hour from the bounded watchdog ring (never mutates it). */
function rssGrowthPerHour(samples: MemorySample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.at - first.at;
  if (spanMs <= 0) return null;
  return ((last.rss - first.rss) / spanMs) * 3_600_000;
}

/** One labelled monospace metric cell inside a stat-row. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value mono">{value}</div>
    </div>
  );
}

export default function MemoryObservabilityCard({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<SystemMemory | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    const fetchMemory = async () => {
      // Serialize polls: a stalled request must not stack up or let an older
      // payload land after a newer one.
      if (inFlight) return;
      inFlight = true;
      // Bound each poll so a hung request cannot pin inFlight forever and
      // starve the unavailable fallback.
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${apiBase}/api/system/memory`, { signal: controller.signal });
        if (!res.ok) throw new Error("memory unavailable");
        const json = await res.json() as SystemMemory;
        if (!cancelled) {
          setData(json);
          setUnavailable(false);
        }
      } catch {
        // Old servers (pre-#314) 404 this route; degrade to a quiet unavailable note.
        if (!cancelled) setUnavailable(true);
      } finally {
        clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        inFlight = false;
      }
    };
    void fetchMemory();
    const interval = setInterval(() => void fetchMemory(), 5000);
    return () => {
      cancelled = true;
      activeController?.abort();
      clearInterval(interval);
    };
  }, [apiBase]);

  if (unavailable && !data) {
    return (
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="font-semibold" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconActivity width={16} height={16} aria-hidden="true" />
          {t("dash.mem.title")}
        </div>
        <div className="muted text-control" style={{ marginTop: 8 }}>{t("dash.mem.unavailable")}</div>
      </div>
    );
  }

  const growth = data?.watchdog ? rssGrowthPerHour(data.watchdog.samples) : null;
  // Optional on purpose: a 200 from an older proxy may lack the responseState field.
  const responseState = data?.responseState;

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="font-semibold" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <IconActivity width={16} height={16} aria-hidden="true" />
        {t("dash.mem.title")}
      </div>

      <div className="stat-row">
        <Stat label={t("dash.mem.rss")} value={data ? formatBytes(data.rss, locale) : "—"} />
        <Stat label={t("dash.mem.jsHeap")} value={data ? `${formatBytes(data.heapUsed, locale)} / ${formatBytes(data.heapTotal, locale)}` : "—"} />
        <Stat label={t("dash.mem.jscHeap")} value={data?.jscHeap ? formatBytes(data.jscHeap.heapSize, locale) : "—"} />
        <Stat
          label={t("dash.mem.growth")}
          value={growth === null ? "—" : `${growth >= 0 ? "+" : "-"}${formatBytes(Math.abs(growth), locale)}${t("dash.mem.perHour")}`}
        />
      </div>

      {/* Secondary diagnostics collapsed by default: only the headline stats stay visible. */}
      <details style={{ marginTop: 10 }}>
        <summary className="muted text-label" style={{ cursor: "pointer", padding: "2px 2px" }}>{t("dash.mem.details")}</summary>
        <div className="muted text-control" style={{ margin: "8px 0 0" }}>{t("dash.mem.hint")}</div>

        <div className="muted text-label" style={{ margin: "14px 0 6px" }}>{t("dash.mem.store")}</div>
        <div className="muted text-control" style={{ marginBottom: 10 }}>{t("dash.mem.storeHint")}</div>
        <div className="stat-row">
          <Stat label={t("dash.mem.storeEntries")} value={responseState ? new Intl.NumberFormat(locale).format(responseState.count) : "—"} />
          <Stat label={t("dash.mem.storeTotal")} value={responseState ? formatBytes(responseState.totalBytes, locale) : "—"} />
          <Stat label={t("dash.mem.storeLargest")} value={responseState ? formatBytes(responseState.largestBytes, locale) : "—"} />
          <Stat
            label={t("dash.mem.storeOldest")}
            // count distinguishes an empty store ("—") from a legit same-tick zero age ("0s").
            value={responseState ? (responseState.count === 0 ? "—" : formatAge(responseState.oldestAgeMs, locale)) : "—"}
          />
        </div>

        {data?.watchdog && (
          <div className="stat-row" style={{ marginTop: 16 }}>
            <Stat label={t("dash.mem.threshold")} value={formatBytes(data.watchdog.warnThresholdBytes, locale)} />
            <Stat
              label={t("dash.mem.lastWarn")}
              value={data.watchdog.lastWarnAt ? new Date(data.watchdog.lastWarnAt).toLocaleString(locale) : t("dash.mem.never")}
            />
          </div>
        )}
      </details>
    </div>
  );
}
