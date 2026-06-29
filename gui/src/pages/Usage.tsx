import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";

type Range = "all" | "30d" | "7d";

interface UsageSummaryTotals {
  requests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
}

interface UsageDay {
  date: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  reportedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageResponse {
  range: Range;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  error?: string;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// Total-tokens card only: Western locales extend K/M with B (billion) and T (trillion); CJK locales
// (ko/zh) use the myriad (1e4) scale — ko 만/억/조/경, zh 万/亿/兆/京 — which reads naturally there.
function formatTotalTokens(n: number, locale: string): string {
  if (locale === "ko" || locale === "zh") {
    const units = locale === "ko"
      ? [{ v: 1e16, s: "경" }, { v: 1e12, s: "조" }, { v: 1e8, s: "억" }, { v: 1e4, s: "만" }]
      : [{ v: 1e16, s: "京" }, { v: 1e12, s: "兆" }, { v: 1e8, s: "亿" }, { v: 1e4, s: "万" }];
    for (const u of units) {
      if (n >= u.v) return `${(n / u.v).toFixed(2)}${u.s}`;
    }
    return String(n);
  }
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n < 1_000_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  return `${(n / 1_000_000_000_000).toFixed(2)}T`;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Stable per-model bar color: hash the provider/model id to a hue so the same model keeps its color
// across days and renders. Saturation/lightness are fixed for a cohesive palette on the dark chart.
function modelColor(model: string, provider: string): string {
  const key = `${provider}/${model}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

// Last 7 calendar days (oldest → newest), zero-filled, for the 7d bar chart. The API's `days` only
// carries dates with activity, so missing days are backfilled to 0 to keep a stable 7-bar axis.
function lastSevenDays(days: UsageDay[]): UsageDay[] {
  const byDate = new Map(days.map(d => [d.date, d]));
  const out: UsageDay[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const d = byDate.get(iso);
    out.push({ date: iso, requests: d?.requests ?? 0, reportedRequests: d?.reportedRequests ?? 0, totalTokens: d?.totalTokens ?? 0, models: d?.models ?? [] });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[]): { weeks: HeatmapCell[][]; months: { label: string; col: number }[]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.requests));
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ label: monthNames[m], col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.requests, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelQuery, setModelQuery] = useState("");
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const fetchUsage = async () => {
      try {
        const res = await fetch(`${apiBase}/api/usage?range=${range}`);
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json() as UsageResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchUsage();
    return () => { cancelled = true; };
  }, [apiBase, range]);

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? []), [data?.days]);
  const weekBars = useMemo(() => lastSevenDays(data?.days ?? []), [data?.days]);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    if (!q) return models.slice(0, 100);
    return models.filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.resolvedModel ?? "").toLowerCase().includes(q),
    ).slice(0, 100);
  }, [data?.models, modelQuery]);

  return (
    <>
      <div className="page-head">
        <h2>{t("usage.title")}</h2>
        <div className="usage-range" role="group" aria-label={t("usage.title")}>
          {(["all", "30d", "7d"] as Range[]).map(r => (
            <button key={r} type="button"
              className={`usage-range-btn${range === r ? " active" : ""}`}
              onClick={() => setRange(r)}>
              {t(`usage.range.${r}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="page-sub">{t("usage.subtitle")}</p>

      {loading && !data ? (
        <div className="empty">{t("usage.loading")}</div>
      ) : !data || data.summary.requests === 0 ? (
        <div className="empty">{t("usage.empty")}</div>
      ) : (
        <>
          <div className="usage-cards">
            <div className="stat"><div className="muted">{t("usage.card.requests")}</div><div className="stat-value">{data.summary.requests}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.totalTokens")}</div><div className="stat-value">{formatTotalTokens(data.summary.totalTokens, locale)}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.coverage")}</div><div className="stat-value">{formatPct(data.summary.coverageRatio)}</div></div>
            <div className="stat"><div className="muted">{t("usage.card.activeDays")}</div><div className="stat-value">{activeDays}</div></div>
          </div>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.heatmap")}</h3>
            {range === "7d" ? (
              <div className="daybars">
                {weekBars.map((d, i) => {
                  const max = Math.max(1, ...weekBars.map(x => x.requests));
                  const pct = Math.round((d.requests / max) * 100);
                  const label = d.date.slice(5);
                  return (
                    <div key={i} className="daybar"
                      onMouseEnter={() => setHoverDay(i)}
                      onMouseLeave={() => setHoverDay(h => (h === i ? null : h))}>
                      <div className="daybar-track">
                        <div className="daybar-stack" style={{ height: `${pct}%` }}>
                          {d.models.map(m => (
                            <div key={`${m.provider}/${m.model}`} className="daybar-seg"
                              style={{
                                flexGrow: m.requests,
                                background: modelColor(m.model, m.provider),
                              }} />
                          ))}
                          {d.models.length === 0 && d.requests > 0 && (
                            <div className="daybar-seg" style={{ flexGrow: 1, background: "var(--green)" }} />
                          )}
                        </div>
                      </div>
                      {hoverDay === i && d.requests > 0 && (
                        <div className="daybar-tip">
                          <div className="daybar-tip-date">{d.date}</div>
                          {d.models.slice(0, 8).map(m => (
                            <div key={`${m.provider}/${m.model}`} className="daybar-tip-row">
                              <span className="daybar-tip-swatch" style={{ background: modelColor(m.model, m.provider) }} />
                              <span className="daybar-tip-name">{m.model}</span>
                              <span className="daybar-tip-val">{m.requests}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <span className="daybar-count">{d.requests}</span>
                      <span className="daybar-label muted">{label}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
            <div className="heatmap">
              <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, 1fr)` }}>
                <span className="heatmap-day-spacer" />
                {heatmap.months.map((m, i) => (
                  <span key={i} className="heatmap-month" style={{ gridColumn: m.col + 2 }}>{m.label}</span>
                ))}
              </div>
              <div className="heatmap-body">
                <div className="heatmap-days">
                  <span /><span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span />
                </div>
                <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 1fr)` }}>
                  {heatmap.weeks.map((week, wi) => (
                    <div key={wi} className="heatmap-week">
                      {week.map((cell, di) => (
                        <div key={`${wi}-${di}`}
                          className={`heatmap-cell heatmap-cell-${cell.level}`}
                          title={cell.date ? `${cell.date}: ${cell.requests} req · ${formatTokens(cell.totalTokens)} tokens` : ""} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="heatmap-legend muted">
                <span>{t("usage.heatmap.less")}</span>
                {[0, 1, 2, 3, 4].map(l => <span key={l} className={`heatmap-cell heatmap-cell-${l}`} />)}
                <span>{t("usage.heatmap.more")}</span>
              </div>
            </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <div className="panel-head">
              <h3 className="panel-title">{t("usage.section.models")}</h3>
              <input className="input" placeholder={t("usage.search.models")}
                value={modelQuery} onChange={e => setModelQuery(e.target.value)} />
            </div>
            <div className="tbl-wrap usage-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("logs.col.model")}</th>
                    <th>{t("logs.col.provider")}</th>
                    <th className="num">{t("usage.col.requests")}</th>
                    <th className="num">{t("usage.col.reported")}</th>
                    <th className="num">{t("usage.col.tokens")}</th>
                    <th>{t("usage.col.share")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModels.map(m => (
                    <tr key={`${m.provider}/${m.model}/${m.resolvedModel ?? ""}`}>
                      <td className="mono">{m.resolvedModel ?? m.model}</td>
                      <td className="muted">{m.provider}</td>
                      <td className="num">{m.requests}</td>
                      <td className="num">{m.reportedRequests}</td>
                      <td className="num mono">{formatTokens(m.totalTokens)}</td>
                      <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(m.shareRatio * 100)}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.providers")}</h3>
            <div className="tbl-wrap usage-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("logs.col.provider")}</th>
                    <th className="num">{t("usage.col.requests")}</th>
                    <th className="num">{t("usage.col.reported")}</th>
                    <th className="num">{t("usage.col.tokens")}</th>
                    <th>{t("usage.col.share")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.providers.map(p => (
                    <tr key={p.provider}>
                      <td className="mono">{p.provider}</td>
                      <td className="num">{p.requests}</td>
                      <td className="num">{p.reportedRequests}</td>
                      <td className="num mono">{formatTokens(p.totalTokens)}</td>
                      <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(p.shareRatio * 100)}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 16 }}>
            <h3 className="panel-title">{t("usage.section.coverage")}</h3>
            <div className="usage-cards" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              <div className="stat"><div className="muted">{t("logs.tokens.reported")}</div><div className="stat-value">{data.summary.reportedRequests}</div></div>
              <div className="stat"><div className="muted">{t("logs.tokens.unreported")}</div><div className="stat-value">{data.summary.unreportedRequests}</div></div>
              <div className="stat"><div className="muted">{t("logs.tokens.unsupported")}</div><div className="stat-value">{data.summary.unsupportedRequests}</div></div>
            </div>
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>{t("usage.coverage.note")}</p>
          </section>
        </>
      )}
    </>
  );
}
