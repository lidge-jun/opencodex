import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

/*
 * MemoryCard — dashboard (beta) panel for the memory watchdog. Three layered, opt-in options:
 *   1. Monitor  — read-only live memory pressure vs total RAM (zero risk).
 *   2. Recommend — advisory thresholds from observed baseline (never applied automatically).
 *   3. Adjust   — toggle/tune thresholds + opt-in auto-restart (management-auth gated; auto-restart
 *                 is further gated by supervisor detection so we never exit into "just dead").
 * Self-contained: it owns its own fetch/poll/PUT so it does not couple to the large Dashboard.
 */

type WatchdogLevel = "ok" | "warn" | "critical";

interface WatchdogDecision {
  level: WatchdogLevel;
  action: string;
  fraction: number;
  pressureMb: number;
  totalMb: number;
  source: string;
  growthMbPerHour: number | null;
  reason: string;
}

interface ResolvedConfig {
  enabled: boolean;
  intervalMs: number;
  warnFraction: number;
  criticalFraction: number;
  autoRestart: boolean;
  requireSupervisor: boolean;
  minRestartIntervalMs: number;
  maxRestarts: number;
  growthWindowMs: number;
}

interface Recommendation {
  warnFraction: number;
  criticalFraction: number;
  autoRestart: boolean;
  rationale: string;
}

interface MemoryReport {
  enabled: boolean;
  decision: WatchdogDecision | null;
  samplesCount?: number;
  growthMbPerHour?: number | null;
  resolvedConfig?: ResolvedConfig;
  supervisor?: { supervised: boolean; hint: string };
  recommendation?: Recommendation;
  restartCount?: number;
}

interface SettingsPatch {
  enabled?: boolean;
  warnFraction?: number;
  criticalFraction?: number;
  autoRestart?: boolean;
  requireSupervisor?: boolean;
}

const LEVEL_COLOR: Record<WatchdogLevel, string> = {
  ok: "var(--green)",
  warn: "var(--amber, #d89614)",
  critical: "var(--red)",
};

function pct(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** Stateless fetch so the polling effect never calls setState synchronously in its body. */
async function loadReport(apiBase: string): Promise<MemoryReport | null> {
  try {
    const res = await fetch(`${apiBase}/api/memory`);
    if (!res.ok) return null;
    return (await res.json()) as MemoryReport;
  } catch {
    return null; // old server / offline — keep the last report
  }
}

export default function MemoryCard({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Draft threshold percents while dragging; committed on "Apply thresholds".
  const [warnDraft, setWarnDraft] = useState<number | null>(null);
  const [critDraft, setCritDraft] = useState<number | null>(null);
  const editingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const data = await loadReport(apiBase);
      if (cancelled) return;
      if (data) setReport(data);
      setLoaded(true);
    };
    void refresh();
    const interval = setInterval(() => {
      // Don't stomp the sliders the user is dragging.
      if (!editingRef.current) void refresh();
    }, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [apiBase]);

  const save = useCallback(async (patch: SettingsPatch) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`${apiBase}/api/memory/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setSaveError(body?.error ?? t("memory.httpError", { status: res.status }));
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      editingRef.current = false;
      const data = await loadReport(apiBase);
      if (data) setReport(data);
    }
  }, [apiBase, t]);

  if (!loaded) return null;
  if (!report || report.enabled === false) {
    return (
      <div className="panel" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong>{t("memory.title")}</strong>
          <span className="badge" style={betaBadge}>beta</span>
        </div>
        <p className="muted text-control" style={{ marginTop: 8 }}>{t("memory.disabledHint")}</p>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={saving}
          onClick={() => void save({ enabled: true })}
        >{t("memory.enable")}</button>
        {saveError && <div className="muted text-label" style={{ color: "var(--red)", marginTop: 6 }}>{saveError}</div>}
      </div>
    );
  }

  const cfg = report.resolvedConfig;
  const decision = report.decision;
  const rec = report.recommendation;
  const sup = report.supervisor;
  const level = decision?.level ?? "ok";
  const fraction = decision?.fraction ?? 0;
  const warnPct = warnDraft ?? (cfg ? Math.round(cfg.warnFraction * 100) : 60);
  const critPct = critDraft ?? (cfg ? Math.round(cfg.criticalFraction * 100) : 75);
  const autoRestartBlocked = !!cfg && cfg.requireSupervisor && !(sup?.supervised);
  const nf = (n: number) => n.toLocaleString(locale);

  const applyThresholds = () => {
    // Server clamps + keeps critical > warn; send fractions.
    void save({ warnFraction: warnPct / 100, criticalFraction: Math.max(critPct, warnPct + 1) / 100 });
  };
  const applyRecommended = () => {
    if (!rec) return;
    setWarnDraft(Math.round(rec.warnFraction * 100));
    setCritDraft(Math.round(rec.criticalFraction * 100));
    void save({
      warnFraction: rec.warnFraction,
      criticalFraction: rec.criticalFraction,
      autoRestart: rec.autoRestart && !autoRestartBlocked ? true : false,
    });
  };

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <strong>{t("memory.title")}</strong>
        <span className="badge" style={betaBadge}>beta</span>
        <span
          className="badge"
          style={{ marginLeft: "auto", background: "transparent", color: LEVEL_COLOR[level], border: `1px solid ${LEVEL_COLOR[level]}`, padding: "2px 8px", borderRadius: "var(--radius-pill)", fontSize: 12 }}
        >{level.toUpperCase()}</span>
      </div>
      <p className="muted text-label" style={{ margin: "0 0 12px" }}>{t("memory.intro")}</p>

      {/* 1. Monitor */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <span className="text-label muted">{t("memory.pressure")}</span>
          <span className="mono text-control">
            {decision ? t("memory.pressureValue", { used: nf(decision.pressureMb), total: nf(decision.totalMb), pct: pct(fraction) }) : "—"}
          </span>
        </div>
        <div style={{ position: "relative", height: 10, borderRadius: 5, background: "var(--surface-soft, var(--raised))", overflow: "hidden" }}>
          <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, pct(fraction))}%`, background: LEVEL_COLOR[level], transition: "width .4s" }} />
          {cfg && <Marker at={cfg.warnFraction * 100} color="var(--amber, #d89614)" />}
          {cfg && <Marker at={cfg.criticalFraction * 100} color="var(--red)" />}
        </div>
        <div className="muted text-label" style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6 }}>
          <span>{t("memory.sourceLabel")} <span className="mono">{decision?.source ?? "—"}</span></span>
          <span>{t("memory.growthLabel")} <span className="mono">{report.growthMbPerHour == null ? t("memory.notAvailable") : t("memory.growthValue", { mb: nf(report.growthMbPerHour) })}</span></span>
          <span>{t("memory.restartsLabel")} <span className="mono">{nf(report.restartCount ?? 0)}</span></span>
          <span>{t("memory.supervisorLabel")} <span className="mono" style={{ color: sup?.supervised ? "var(--green)" : "var(--muted)" }}>{sup?.supervised ? t("memory.supervisorDetected", { hint: sup.hint }) : t("memory.supervisorNotDetected")}</span></span>
        </div>
      </div>

      {/* 2. Recommend */}
      {rec && (
        <div style={{ marginBottom: 14, padding: "8px 10px", borderRadius: 8, background: "var(--surface-soft, var(--raised))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="text-label" style={{ fontWeight: 600 }}>{t("memory.recommended")}</span>
            <span className="text-label muted">{t("memory.recSummary", {
              warn: Math.round(rec.warnFraction * 100),
              crit: Math.round(rec.criticalFraction * 100),
              auto: rec.autoRestart ? t("memory.yes") : t("memory.no"),
            })}</span>
            <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={saving} onClick={applyRecommended}>{t("memory.applyRecommended")}</button>
          </div>
          <div className="muted text-label" style={{ marginTop: 4 }}>{rec.rationale}</div>
        </div>
      )}

      {/* 3. Adjust */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={rowStyle}>
          <input type="checkbox" checked={cfg?.enabled ?? true} disabled={saving} onChange={e => void save({ enabled: e.target.checked })} />
          <span>{t("memory.enabledLabel")}</span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Slider label={t("memory.warnLabel")} value={warnPct} min={10} max={99}
            onChange={v => { editingRef.current = true; setWarnDraft(v); }} />
          <Slider label={t("memory.criticalLabel")} value={critPct} min={10} max={99}
            onChange={v => { editingRef.current = true; setCritDraft(v); }} />
          <div>
            <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={applyThresholds}>{t("memory.applyThresholds")}</button>
          </div>
        </div>

        <label style={{ ...rowStyle, opacity: autoRestartBlocked ? 0.55 : 1 }}>
          <input type="checkbox" checked={cfg?.autoRestart ?? false} disabled={saving || autoRestartBlocked} onChange={e => void save({ autoRestart: e.target.checked })} />
          <span>{t("memory.autoRestartLabel")}</span>
        </label>
        {autoRestartBlocked && (
          <div className="muted text-label" style={{ marginTop: -4, marginLeft: 24 }}>{t("memory.autoRestartBlocked")}</div>
        )}
        <div className="muted text-label" style={{ marginTop: -4, marginLeft: 24 }}>{t("memory.autoRestartNote")}</div>
        <label style={rowStyle}>
          <input type="checkbox" checked={cfg?.requireSupervisor ?? true} disabled={saving} onChange={e => void save({ requireSupervisor: e.target.checked })} />
          <span>{t("memory.requireSupervisorLabel")}</span>
        </label>

        <div className="text-label" style={{ minHeight: 16 }}>
          {saving && <span className="muted">{t("common.saving")}</span>}
          {!saving && saveError && <span style={{ color: "var(--red)" }}>{saveError}</span>}
        </div>
      </div>
    </div>
  );
}

const betaBadge: React.CSSProperties = {
  background: "transparent",
  color: "var(--muted)",
  border: "1px solid var(--border, var(--muted))",
  padding: "1px 7px",
  borderRadius: "var(--radius-pill)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };

function Marker({ at, color }: { at: number; color: string }) {
  return <div style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(100, Math.max(0, at))}%`, width: 2, background: color, opacity: 0.8 }} />;
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="text-label muted" style={{ width: 78 }}>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} style={{ flex: 1 }} />
      <span className="mono text-label" style={{ width: 36, textAlign: "right" }}>{value}%</span>
    </label>
  );
}
