import { useEffect, useState } from "react";
import { formatUptime } from "../formatUptime";
import { IconActivity } from "../icons";
import { useI18n, type Locale, type TFn } from "../i18n/shared";
import { createBoundedFetch, type BoundedFetch } from "../bounded-fetch";
import { startVisibilityPoll } from "../visibility-poll";

/**
 * Memory observability card. Polls GET /api/system/memory (#314 WP3) every 5s
 * and renders scalar diagnostics. Also hosts the confirm-gated Drain & restart
 * action (#563): longer 60s drain, then respawn via ensure/service — not the
 * short /api/stop teardown path.
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
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillReadFailures: number;
}

interface SystemMemory {
  pid?: number;
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
  /** Absent on older proxies predating the drain-and-restart action (#563). */
  activeTurnCount?: number;
  isDraining?: boolean;
  watchdog: { warnThresholdBytes: number; lastWarnAt: number | null; observedBytes?: number; observedMetric?: MemoryMetric; samples: MemorySample[] } | null;
}

type RestartPhase = "idle" | "draining" | "reconnecting" | "error";

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
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "danger" }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value mono${tone ? ` value--${tone}` : ""}`}>{value}</div>
      {sub && <div className="stat-sub mono">{sub}</div>}
    </div>
  );
}

/**
 * Headline pressure gauge: observed memory against the watchdog warn threshold.
 * The scalar cells below answer "what is allocated"; this answers "is that a
 * problem", which is the only question a glance at this panel should need.
 */
function MemoryPressure({
  observedBytes,
  thresholdBytes,
  metric,
  locale,
  t,
}: {
  observedBytes: number | null;
  thresholdBytes: number | null;
  metric: MemoryMetric | null;
  locale: Locale;
  t: TFn;
}) {
  const ratio =
    observedBytes !== null && thresholdBytes !== null && thresholdBytes > 0
      ? observedBytes / thresholdBytes
      : null;
  // Warn before the watchdog fires, not at the same instant: 75% is the point
  // where a still-climbing process is worth looking at.
  const tone = ratio === null ? "unknown" : ratio >= 1 ? "over" : ratio >= 0.75 ? "warn" : "ok";
  const pct = ratio === null ? null : Math.round(ratio * 100);
  return (
    <div className={`mem-pressure mem-pressure--${tone}`}>
      <div className="mem-pressure-head">
        <span className="mem-pressure-label">
          {t("dash.mem.pressure")}
          {metric ? <span className="mem-pressure-metric mono">{metric}</span> : null}
        </span>
        <span className="mem-pressure-figure mono">
          {observedBytes === null ? "—" : formatBytes(observedBytes, locale)}
          {thresholdBytes !== null && (
            <span className="mem-pressure-limit">
              {" / "}
              {formatBytes(thresholdBytes, locale)}
            </span>
          )}
        </span>
      </div>
      <div className="mem-pressure-track" role="presentation">
        <span
          className="mem-pressure-fill"
          style={{ ["--mem-scale" as string]: String(ratio === null ? 0 : Math.min(1, Math.max(0.01, ratio))) }}
        />
      </div>
      <div className="mem-pressure-foot">
        {pct === null ? t("dash.mem.pressureUnknown") : t("dash.mem.pressureOf", { pct })}
      </div>
    </div>
  );
}

const DRAIN_TIMEOUT_S = 60;
const RECONNECT_POLL_MS = 1500;
const RECONNECT_GIVE_UP_MS = 120_000;

export default function MemoryObservabilityCard({ apiBase }: { apiBase: string }) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<SystemMemory | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [restartPhase, setRestartPhase] = useState<RestartPhase>("idle");
  const [restartError, setRestartError] = useState<string | null>(null);
  const [noSupervisor, setNoSupervisor] = useState(false);
  const [supportsRestart, setSupportsRestart] = useState(false);
  const [restartFromPid, setRestartFromPid] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/startup-health`);
        if (!res.ok || cancelled) return;
        const json = await res.json() as { protection?: string };
        if (!cancelled) setNoSupervisor(json.protection === "none");
      } catch {
        /* older proxies / offline — leave warning off */
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let active: BoundedFetch | null = null;
    const fetchMemory = async () => {
      // Serialize polls: a stalled request must not stack up or let an older
      // payload land after a newer one.
      if (inFlight) return;
      inFlight = true;
      // Bound each poll so a hung request cannot pin inFlight forever.
      const bounded = createBoundedFetch(10_000);
      active = bounded;
      try {
        const res = await fetch(`${apiBase}/api/system/memory`, { signal: bounded.signal });
        if (!res.ok) throw new Error("memory unavailable");
        const json = await res.json() as SystemMemory;
        if (cancelled) return;
        setData(json);
        setUnavailable(false);
        setSupportsRestart(typeof json.activeTurnCount === "number");
        if (json.isDraining && restartPhase === "idle") setRestartPhase("draining");
        // Fast recycle can finish between polls with no observed outage — detect pid change.
        if (
          (restartPhase === "draining" || restartPhase === "reconnecting")
          && restartFromPid != null
          && typeof json.pid === "number"
          && json.pid !== restartFromPid
          && !json.isDraining
        ) {
          setRestartPhase("idle");
          setRestartFromPid(null);
          setRestartError(null);
        }
      } catch {
        // Old servers (pre-#314) 404 this route; degrade to a quiet unavailable note.
        // During drain/restart the proxy goes away — switch to reconnect polling.
        if (cancelled) return;
        if (restartPhase === "draining" || restartPhase === "reconnecting") {
          setRestartPhase("reconnecting");
        } else {
          setUnavailable(true);
        }
      } finally {
        bounded.clear();
        if (active === bounded) active = null;
        inFlight = false;
      }
    };
    void fetchMemory();
    // Hidden tabs show no one the paint: no timer, no /api/system/memory traffic.
    // The restart-reconnect loop below is the deliberate exception — it exists to
    // notice the server coming back while nobody watches, is bounded, and only runs
    // while a restart is actually in progress.
    const stop = startVisibilityPoll(() => void fetchMemory(), 5000);
    return () => {
      cancelled = true;
      active?.controller.abort();
      active?.clear();
      stop();
    };
  }, [apiBase, restartPhase, restartFromPid]);

  useEffect(() => {
    if (restartPhase !== "reconnecting") return;
    let cancelled = false;
    let inFlight = false;
    let active: BoundedFetch | null = null;
    const started = Date.now();
    const tick = () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      const bounded = createBoundedFetch(5_000);
      active = bounded;
      void fetch(`${apiBase}/healthz`, { cache: "no-store", signal: bounded.signal })
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) {
            if (Date.now() - started >= RECONNECT_GIVE_UP_MS) {
              setRestartPhase("error");
              setRestartError(t("dash.mem.restartFailed"));
            }
            return;
          }
          let replaced = restartFromPid == null;
          if (restartFromPid != null) {
            try {
              const health = await res.json() as { pid?: number };
              replaced = typeof health.pid === "number" && health.pid !== restartFromPid;
            } catch {
              replaced = true;
            }
          }
          if (cancelled) return;
          if (replaced) {
            setRestartPhase("idle");
            setRestartFromPid(null);
            setRestartError(null);
            return;
          }
          if (Date.now() - started >= RECONNECT_GIVE_UP_MS) {
            setRestartPhase("error");
            setRestartError(t("dash.mem.restartFailed"));
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (Date.now() - started >= RECONNECT_GIVE_UP_MS) {
            setRestartPhase("error");
            setRestartError(t("dash.mem.restartFailed"));
          }
        })
        .finally(() => {
          bounded.clear();
          if (active === bounded) active = null;
          inFlight = false;
        });
    };
    tick();
    const interval = setInterval(tick, RECONNECT_POLL_MS);
    return () => {
      cancelled = true;
      active?.controller.abort();
      active?.clear();
      clearInterval(interval);
    };
  }, [apiBase, restartPhase, restartFromPid, t]);

  const confirmRestart = () => {
    const count = data?.activeTurnCount ?? 0;
    const lines = [
      t("dash.mem.restartConfirm", { count, seconds: DRAIN_TIMEOUT_S }),
    ];
    if (noSupervisor) lines.push(t("dash.mem.restartNoSupervisor"));
    if (!window.confirm(lines.join("\n\n"))) return;
    void (async () => {
      setRestartError(null);
      setRestartFromPid(typeof data?.pid === "number" ? data.pid : null);
      setRestartPhase("draining");
      try {
        const res = await fetch(`${apiBase}/api/system/restart`, { method: "POST" });
        if (!res.ok) throw new Error("restart_failed");
        // Proxy will drain then exit; memory poll will trip reconnecting or pid change.
      } catch {
        setRestartPhase("error");
        setRestartFromPid(null);
        setRestartError(t("dash.mem.restartFailed"));
      }
    })();
  };

  if (unavailable && !data && restartPhase === "idle") {
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
  // Drift only matters relative to the headroom it eats. Flag it when the current
  // climb would reach the warn threshold within an hour (danger) or a shift (warn);
  // a flat or falling process stays neutral no matter how large it already is.
  const growthTone = ((): "warn" | "danger" | undefined => {
    const threshold = data?.watchdog?.warnThresholdBytes;
    if (growth === null || growth <= 0 || observedBytes === null || !threshold) return undefined;
    const headroom = threshold - observedBytes;
    if (headroom <= 0) return "danger";
    const hoursLeft = headroom / growth;
    if (hoursLeft <= 1) return "danger";
    if (hoursLeft <= 8) return "warn";
    return undefined;
  })();
  // Optional on purpose: a 200 from an older proxy may lack the responseState field.
  const responseState = data?.responseState;
  const activeTurns = data?.activeTurnCount;
  const busy = restartPhase === "draining" || restartPhase === "reconnecting";

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      {/* Title row carries the in-flight count and the restart action: as its own
          block below the stats it cost ~87px of near-empty panel height. */}
      <div className="mem-head">
        <div className="font-semibold mem-head-title">
          <IconActivity width={16} height={16} aria-hidden="true" />
          {t("dash.mem.title")}
        </div>
        {supportsRestart && (
          <div className="mem-head-actions">
            <span className="mem-inflight">
              <span className="mem-inflight-label">{t("dash.mem.inFlight")}</span>
              <span className="mem-inflight-value mono">
                {typeof activeTurns === "number" ? plainNumberFormat(locale).format(activeTurns) : "—"}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={confirmRestart}
            >
              {t("dash.mem.restart")}
            </button>
          </div>
        )}
      </div>

      <MemoryPressure
        observedBytes={observedBytes}
        thresholdBytes={data?.watchdog?.warnThresholdBytes ?? null}
        metric={observedBy}
        locale={locale}
        t={t}
      />

      <div className="stat-row mem-stats">
        <Stat label={t("dash.mem.rss")} value={data ? formatBytes(data.rss, locale) : "—"} />
        {/* heapUsed can exceed heapTotal on Bun (external buffers are counted in
            used but not in the JS-object arena), so a "used / total" label reads
            as a contradiction. Show the live figure and demote the arena size. */}
        <Stat
          label={t("dash.mem.jsHeap")}
          value={data ? formatBytes(data.heapUsed, locale) : "—"}
          sub={data ? t("dash.mem.jsHeapArena", { total: formatBytes(data.heapTotal, locale) }) : undefined}
        />
        <Stat label={t("dash.mem.jscHeap")} value={data?.jscHeap ? formatBytes(data.jscHeap.heapSize, locale) : "—"} />
        <Stat
          label={t("dash.mem.growth")}
          value={growth === null ? "—" : `${growth >= 0 ? "+" : "−"}${formatBytes(Math.abs(growth), locale)}${t("dash.mem.perHour")}`}
          tone={growthTone}
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

      {/* Status line only: it stays out of the layout entirely while idle so the
          panel does not reserve a row for a message that is usually absent. */}
      {supportsRestart && (
        <div className="mem-status" aria-live="polite">
          {restartPhase === "draining" && (
            <span className="muted text-control">
              {t("dash.mem.draining", { count: typeof activeTurns === "number" ? activeTurns : 0 })}
            </span>
          )}
          {restartPhase === "reconnecting" && (
            <span className="muted text-control">{t("dash.mem.reconnecting")}</span>
          )}
          {restartPhase === "error" && restartError && (
            <span className="text-control" style={{ color: "var(--danger, #c44)" }}>{restartError}</span>
          )}
          {noSupervisor && restartPhase === "idle" && (
            <span className="muted text-control">{t("dash.mem.restartNoSupervisor")}</span>
          )}
        </div>
      )}
    </div>
  );
}
