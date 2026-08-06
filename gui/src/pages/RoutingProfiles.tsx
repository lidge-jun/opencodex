import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";

type ProfileDto = {
  id: string;
  model: string;
  revision: string;
  candidates: Array<{ provider: string; model: string }>;
  require: Record<string, unknown>;
  optimize: Record<string, number>;
  limits: Record<string, number>;
  unknownEvidence: Record<string, string>;
};

type DryRunCandidate = {
  provider: string;
  model: string;
  eligible: boolean;
  exclusions: Array<{ code: string; detail?: string }>;
  score?: { total: number; components: Record<string, number | undefined> };
};

type Analytics = {
  totalRequests: number;
  successRate: number | null;
  fallbackRate: number | null;
  confidence: string | null;
  historyTruncated: boolean;
  cooldownTriggeringFailures: number;
  durationMs: { p50?: number; p95?: number; p99?: number; sampleCount: number };
  firstOutputMs: { p50?: number; p95?: number; p99?: number; sampleCount: number; coverage: number | null };
  breakdown: Array<{ provider: string; model: string; requests: number; successRate: number | null; p50DurationMs?: number }>;
};

type DryRunResult = {
  candidates: DryRunCandidate[];
  selectedIndex: number | null;
  trace?: { profile?: { revision?: string } };
};

function fmtMs(value: number | undefined, unavailable: string): string {
  return value === undefined ? unavailable : `${Math.round(value)}ms`;
}

function fmtRate(value: number | null | undefined, unavailable: string): string {
  return value === null || value === undefined ? unavailable : `${Math.round(value * 100)}%`;
}

function pickSelectedProfile(next: ProfileDto[], current: ProfileDto | null): ProfileDto | null {
  if (current) {
    const refreshed = next.find(profile => profile.id === current.id);
    if (refreshed) return refreshed;
  }
  return next[0] ?? null;
}

function shouldClearDryRunOnSelectionChange(
  current: ProfileDto | null,
  next: ProfileDto | null,
): boolean {
  if (!current) return false;
  if (!next) return true;
  return current.id !== next.id || current.revision !== next.revision;
}

export default function RoutingProfiles({ apiBase }: { apiBase: string }) {
  const t = useT();
  const unavailable = t("routing.unavailable");
  const [profiles, setProfiles] = useState<ProfileDto[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<ProfileDto | null>(null);
  const [context, setContext] = useState("");
  const [tools, setTools] = useState(false);
  const [image, setImage] = useState(false);
  const [structured, setStructured] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState("");
  const [running, setRunning] = useState(false);
  const selectedRef = useRef<ProfileDto | null>(null);
  const dryRunGenerationRef = useRef(0);

  const clearDryRun = useCallback(() => {
    dryRunGenerationRef.current += 1;
    setDryRunResult(null);
    setDryRunError("");
  }, []);

  const selectProfile = useCallback((profile: ProfileDto | null) => {
    selectedRef.current = profile;
    setSelected(profile);
    clearDryRun();
  }, [clearDryRun]);

  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoadError("");
    try {
      const [profilesRes, analyticsRes] = await Promise.all([
        fetch(`${apiBase}/api/routing-profiles`),
        fetch(`${apiBase}/api/routing-analytics`),
      ]);
      if (generation !== loadGenerationRef.current) return;
      if (!profilesRes.ok) throw new Error(`load-${profilesRes.status}`);
      const profilesJson = await profilesRes.json() as { profiles?: ProfileDto[] };
      if (generation !== loadGenerationRef.current) return;
      let analyticsJson: Analytics | null = null;
      if (analyticsRes.ok) {
        analyticsJson = await analyticsRes.json() as Analytics;
        if (generation !== loadGenerationRef.current) return;
      }
      // Apply state only after every body await, and only while this load is still current.
      if (generation !== loadGenerationRef.current) return;
      const next = profilesJson.profiles ?? [];
      const current = selectedRef.current;
      const refreshed = pickSelectedProfile(next, current);
      selectedRef.current = refreshed;
      setProfiles(next);
      setSelected(refreshed);
      if (shouldClearDryRunOnSelectionChange(current, refreshed)) {
        clearDryRun();
      }
      setAnalytics(analyticsJson);
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [apiBase, clearDryRun]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const runDryRun = async () => {
    if (!selected) return;
    const generation = ++dryRunGenerationRef.current;
    setRunning(true);
    setDryRunResult(null);
    setDryRunError("");
    try {
      const evidence: Record<string, number | boolean> = {};
      const contextTokens = context.trim() ? Number(context.trim()) : NaN;
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        evidence.contextWindow = contextTokens;
      }
      if (tools) evidence.toolsRequired = true;
      if (image) evidence.imageInputRequired = true;
      if (structured) evidence.structuredOutputRequired = true;
      const response = await fetch(`${apiBase}/api/routing-profiles/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: selected.id,
          evidence,
        }),
      });
      if (generation !== dryRunGenerationRef.current) return;
      if (!response.ok) {
        let message = `dry-run ${response.status}`;
        try {
          const body = await response.json() as { error?: { message?: string } };
          message = body.error?.message ?? message;
        } catch {
          // Keep the status fallback when the error body is not JSON.
        }
        if (generation !== dryRunGenerationRef.current) return;
        setDryRunError(message);
        return;
      }
      const result = await response.json() as DryRunResult;
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunResult(result);
    } catch (error) {
      if (generation !== dryRunGenerationRef.current) return;
      setDryRunError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === dryRunGenerationRef.current) {
        setRunning(false);
      }
    }
  };

  return (
    <div className="page" data-page="routing">
      <div className="page-head">
        <h2>{t("routing.title")}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>{t("common.retry")}</button>
      </div>
      <p className="muted">{t("routing.subtitle")}</p>

      {loadError ? <Notice tone="err">{t("routing.loadFailed")}: {loadError}</Notice> : null}

      {profiles.length === 0 && !loadError ? (
        <div className="panel">{t("routing.empty")}</div>
      ) : (
        <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {profiles.map(profile => (
            <button
              key={profile.id}
              type="button"
              className="model-card"
              style={{ textAlign: "left", cursor: "pointer" }}
              onClick={() => selectProfile(profile)}
              aria-pressed={selected?.id === profile.id}
            >
              <div className="card-badges">
                <strong>{profile.id}</strong>
                <span className="badge badge-muted">{profile.model}</span>
                <span className="badge badge-muted">{t("routing.revision")}: {profile.revision}</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <h3>{t("routing.detail")}: {selected.model}</h3>
          <div>
            <span className="field-label">{t("routing.candidates")}</span>
            <div className="model-grid">
              {selected.candidates.map(candidate => (
                <div key={`${candidate.provider}/${candidate.model}`} className="model-card">
                  {candidate.provider}/{candidate.model}
                </div>
              ))}
            </div>
          </div>
          {([
            ["routing.require", selected.require, true],
            ["routing.optimize", selected.optimize, false],
            ["routing.limits", selected.limits, true],
            ["routing.unknownEvidence", selected.unknownEvidence, false],
          ] as const).map(([labelKey, value, allowEmpty]) => (
            <div key={labelKey}>
              <span className="field-label">{t(labelKey)}</span>
              <pre className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {allowEmpty && Object.keys(value).length === 0
                  ? t("routing.none")
                  : JSON.stringify(value, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.dryRun")}</h3>
        <label className="field-label" htmlFor="routing-context">
          {t("routing.dryRunContext")}
          <input
            id="routing-context"
            className="input"
            type="number"
            min={1}
            value={context}
            onChange={event => {
              setContext(event.target.value);
              clearDryRun();
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={tools}
            onChange={event => {
              setTools(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunTools")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={image}
            onChange={event => {
              setImage(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunImage")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={structured}
            onChange={event => {
              setStructured(event.target.checked);
              clearDryRun();
            }}
          />
          {t("routing.dryRunStructured")}
        </label>
        <button type="button" className="btn btn-primary" disabled={!selected || running} onClick={() => void runDryRun()}>
          {t("routing.dryRunRun")}
        </button>
        {dryRunError ? <Notice tone="err">{dryRunError}</Notice> : null}
        {dryRunResult ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("routing.candidate")}</th>
                <th>{t("routing.eligible")}</th>
                <th>{t("routing.exclusions")}</th>
                <th>{t("routing.score")}</th>
              </tr>
            </thead>
            <tbody>
              {dryRunResult.candidates.map((candidate, index) => (
                <tr key={`${candidate.provider}/${candidate.model}`}>
                  <td>
                    {candidate.provider}/{candidate.model}
                    {index === dryRunResult.selectedIndex ? ` ✓ (${t("routing.selected")})` : ""}
                  </td>
                  <td>{candidate.eligible ? t("routing.yes") : t("routing.no")}</td>
                  <td>{candidate.exclusions.map(exclusion => exclusion.code).join(", ") || t("routing.none")}</td>
                  <td>{candidate.score ? candidate.score.total.toFixed(3) : unavailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="panel" style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h3>{t("routing.analytics")}</h3>
        {analytics ? (
          <>
            <div className="card-badges">
              <span className="badge badge-muted">{t("routing.analyticsTotal")}: {analytics.totalRequests}</span>
              <span className="badge badge-muted">{t("routing.analyticsSuccessRate")}: {fmtRate(analytics.successRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsFallbackRate")}: {fmtRate(analytics.fallbackRate, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP50")}: {fmtMs(analytics.durationMs.p50, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP95")}: {fmtMs(analytics.durationMs.p95, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsP99")}: {fmtMs(analytics.durationMs.p99, unavailable)}</span>
              <span className="badge badge-muted">{t("routing.analyticsCooldown")}: {analytics.cooldownTriggeringFailures}</span>
              <span className="badge badge-muted">{t("routing.analyticsConfidence")}: {analytics.confidence ?? unavailable}</span>
              {analytics.historyTruncated ? <span className="badge badge-muted">{t("routing.analyticsTruncated")}</span> : null}
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("routing.candidate")}</th>
                  <th>{t("routing.analyticsRequests")}</th>
                  <th>{t("routing.analyticsSuccessRate")}</th>
                  <th>{t("routing.analyticsP50")}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.breakdown.map(row => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <td>{row.provider}/{row.model}</td>
                    <td>{row.requests}</td>
                    <td>{fmtRate(row.successRate, unavailable)}</td>
                    <td>{fmtMs(row.p50DurationMs, unavailable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">{t("routing.analyticsEmpty")}</p>
        )}
      </div>
    </div>
  );
}
