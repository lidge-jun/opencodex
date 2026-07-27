import { useEffect, useState } from "react";
import { formatUptime } from "../formatUptime";
import { IconActivity } from "../icons";
import { useI18n, type Locale } from "../i18n/shared";

/**
 * Read-only Memory observability card. Polls GET /api/system/memory (the #314 WP3
 * service-process introspection surface) every 5s and renders scalar diagnostics
 * only: no sliders, no restart toggle, no PUT. Observed memory is the largest
 * of RSS, external, and ArrayBuffers so Windows working-set trimming does not
 * hide committed retention; a rising continuation-store total under rising
 * observed memory points at conversation retention.
 */

interface MemorySample {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external?: number;
  arrayBuffers?: number;
  observedBytes?: number;
  observedMetric?: MemoryMetric;
}

type MemoryMetric = "rss" | "external" | "arrayBuffers";

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
  external?: number;
  arrayBuffers?: number;
  observedBytes?: number;
  observedMetric?: MemoryMetric;
  jscHeap: { heapSize: number; heapCapacity: number; objectCount: number } | null;
  /** Absent on older proxies whose /api/system/memory predates the continuation-store metrics. */
  responseState?: ResponseState;
  watchdog: { warnThresholdBytes: number; lastWarnAt: number | null; observedBytes?: number; observedMetric?: MemoryMetric; samples: MemorySample[] } | null;
}

/**
 * Render a byte count with a binary-scaled unit; non-finite/zero inputs render as "0 B".
 * The divisor is 1024, so the labels must be the binary ones (KiB/MiB/...). Labelling a
 * 1024-scaled value "KB" misreports it by ~2.4% per step, which is exactly the kind of drift a
 * memory diagnostic must not introduce. The number itself goes through the active locale so it
 * matches every other figure on this dashboard.
 */
const byteNumberFormats = new Map<string, Intl.NumberFormat>();
function byteNumberFormat(locale: Locale, fractionDigits: number): Intl.NumberFormat {
  const key = `${locale}:${fractionDigits}`;
  let fmt = byteNumberFormats.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    byteNumberFormats.set(key, fmt);
  }
  return fmt;
}
const plainNumberFormats = new Map<string, Intl.NumberFormat>();
function plainNumberFormat(locale: Locale): Intl.NumberFormat {
  let fmt = plainNumberFormats.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale);
    plainNumberFormats.set(locale, fmt);
  }
  return fmt;
}

function formatBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const formatted = byteNumberFormat(locale, exp === 0 ? 0 : 1).format(value);
  return `${formatted} ${units[exp]}`;
}

/** Render a millisecond age via the locale-aware uptime formatter; invalid/negative ages render as "—". */
function formatAge(ms: number, locale: Locale): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return formatUptime(ms / 1000, locale);
}

function observedMemory(sample: Pick<MemorySample, "rss" | "external" | "arrayBuffers" | "observedBytes">): number {
  if (typeof sample.observedBytes === "number") return sample.observedBytes;
  return Math.max(sample.rss, sample.external ?? 0, sample.arrayBuffers ?? 0);
}

function observedMetric(data: SystemMemory): MemoryMetric {
  if (data.observedMetric) return data.observedMetric;
  if (data.watchdog?.observedMetric) return data.watchdog.observedMetric;
  const values: Array<{ metric: MemoryMetric; bytes: number }> = [
    { metric: "rss", bytes: data.rss },
    { metric: "external", bytes: data.external ?? 0 },
    { metric: "arrayBuffers", bytes: data.arrayBuffers ?? 0 },
  ];
  return values.reduce((best, next) => next.bytes > best.bytes ? next : best, values[0]).metric;
}

/** Derive observed-memory drift per hour from the bounded watchdog ring (never mutates it). */
function observedGrowthPerHour(samples: MemorySample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.at - first.at;
  if (spanMs <= 0) return null;
  return ((observedMemory(last) - observedMemory(first)) / spanMs) * 3_600_000;
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
      // starve the unavailable fallback. Prefer AbortSignal.timeout; fall back
      // to a manual timer when the browser lacks AbortSignal.any/timeout.
      const controller = new AbortController();
      activeController = controller;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const signal = typeof AbortSignal !== "undefined" && "any" in AbortSignal && "timeout" in AbortSignal
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
        : (() => {
          timeoutId = setTimeout(() => controller.abort(), 10_000);
          return controller.signal;
        })();
      try {
        const res = await fetch(`${apiBase}/api/system/memory`, { signal });
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
        if (timeoutId !== undefined) clearTimeout(timeoutId);
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

  const growth = data?.watchdog ? observedGrowthPerHour(data.watchdog.samples) : null;
  const observedBytes = data ? data.observedBytes ?? data.watchdog?.observedBytes ?? observedMemory(data) : null;
  const observedBy = data ? observedMetric(data) : null;
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

        <div className="muted text-label" style={{ margin: "14px 0 6px" }}>{t("dash.mem.runtime")}</div>
        <div className="stat-row">
          <Stat label={t("dash.mem.observed")} value={observedBytes === null ? "—" : `${formatBytes(observedBytes, locale)} (${observedBy})`} />
          <Stat label={t("dash.mem.external")} value={data?.external === undefined ? "—" : formatBytes(data.external, locale)} />
          <Stat label={t("dash.mem.arrayBuffers")} value={data?.arrayBuffers === undefined ? "—" : formatBytes(data.arrayBuffers, locale)} />
        </div>

        <div className="muted text-label" style={{ margin: "14px 0 6px" }}>{t("dash.mem.store")}</div>
        <div className="muted text-control" style={{ marginBottom: 10 }}>{t("dash.mem.storeHint")}</div>
        <div className="stat-row">
          <Stat label={t("dash.mem.storeEntries")} value={responseState ? plainNumberFormat(locale).format(responseState.count) : "—"} />
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
