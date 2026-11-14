import { useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import { IconRefresh } from "../../icons";

interface ArrivalRow { id: string; at: string; state?: string }

interface RefreshResponse {
  ok?: boolean;
  applicable?: boolean;
  discovery?: { status: string; reason?: string; httpStatus?: number } | null;
  liveModelCount?: number | null;
  newArrivals?: ArrivalRow[];
  recentArrivals?: ArrivalRow[];
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; liveModelCount: number | null; added: string[] }
  | { kind: "static" }
  | { kind: "failed"; detail?: string };

const MAX_LISTED = 12;

function arrivalRows(value: unknown): ArrivalRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is ArrivalRow => !!row && typeof row === "object"
      && typeof (row as ArrivalRow).id === "string" && typeof (row as ArrivalRow).at === "string")
    : [];
}

function formatArrivalTime(at: string): string {
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : at;
}

/**
 * Manual "discover now" for one provider plus its recent arrivals. Sits under the
 * "Discover models from provider" setting, and only while that setting is on.
 */
export default function ProviderModelDiscovery({ apiBase, provider }: { apiBase: string; provider: string }) {
  const t = useT();
  const [recent, setRecent] = useState<ArrivalRow[]>([]);
  const [run, setRun] = useState<RunState>({ kind: "idle" });

  useEffect(() => {
    // The parent keys this component by server and provider, so state starts fresh per provider.
    let cancelled = false;
    fetch(`${apiBase}/api/model-discovery`)
      .then(response => response.ok ? response.json() : null)
      .then((json: { recentArrivals?: Record<string, unknown> } | null) => {
        if (!cancelled) setRecent(arrivalRows(json?.recentArrivals?.[provider]));
      })
      .catch(() => { /* The list is informational; the button still works. */ });
    return () => { cancelled = true; };
  }, [apiBase, provider]);

  const discover = async () => {
    setRun({ kind: "running" });
    try {
      const response = await fetch(`${apiBase}/api/model-discovery/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const json = await response.json().catch(() => null) as RefreshResponse | null;
      if (!response.ok || !json) { setRun({ kind: "failed" }); return; }
      if (json.applicable === false) { setRun({ kind: "static" }); return; }
      setRecent(arrivalRows(json.recentArrivals));
      if (json.discovery?.status === "failed") {
        const detail = [json.discovery.reason, json.discovery.httpStatus ? `HTTP ${json.discovery.httpStatus}` : null].filter(Boolean).join(" · ");
        setRun({ kind: "failed", ...(detail ? { detail } : {}) });
        return;
      }
      setRun({ kind: "done", liveModelCount: json.liveModelCount ?? null, added: arrivalRows(json.newArrivals).map(row => row.id) });
    } catch {
      setRun({ kind: "failed" });
    }
  };

  const added = run.kind === "done" ? new Set(run.added) : new Set<string>();
  const listed = [...recent].reverse().slice(0, MAX_LISTED);
  return (
    <section className="pwi-pacing-card" aria-labelledby="pwi-model-discovery-title">
      <div className="pwi-pacing-head">
        <div>
          <h3 id="pwi-model-discovery-title">{t("modelDiscover.recent")}</h3>
          <p role="status" aria-live="polite">
            {run.kind === "done" && t("modelDiscover.result", { count: run.liveModelCount ?? "?", added: run.added.length })}
            {run.kind === "static" && t("modelDiscover.static")}
            {run.kind === "failed" && `${t("modelDiscover.failed")}${run.detail ? ` · ${run.detail}` : ""}`}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={run.kind === "running"}
          aria-busy={run.kind === "running"} onClick={() => { void discover(); }}>
          <IconRefresh width={14} height={14} aria-hidden="true" />
          {" "}
          {run.kind === "running" ? t("modelDiscover.running") : t("modelDiscover.now")}
        </button>
      </div>
      {listed.length === 0 ? (
        <p className="muted text-label">{t("modelDiscover.none")}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {listed.map(row => (
            <li key={`${row.id}\0${row.at}`} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
              {added.has(row.id) && <span className="badge badge-primary">{t("modelDiscover.new")}</span>}
              <code>{row.id}</code>
              <span className="faint text-label">{formatArrivalTime(row.at)}</span>
              {row.state === "auto-disabled" && <span className="badge badge-muted">{t("modelDiscover.autoDisabled")}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
