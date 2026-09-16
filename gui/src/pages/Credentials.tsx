import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../styles-credentials-workspace.css";
import { CREDENTIALS_TAB_HASHES } from "../app-routing";
import { useDataSurface } from "../data-surface";
import { readJsonIfOk } from "../fetch-json";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";

export interface CredentialsProps {
  apiBase: string;
}

type TabType =
  | "overview"
  | "list"
  | "providers"
  | "oauth"
  | "pool"
  | "health"
  | "quota"
  | "policies"
  | "approvals"
  | "audit";

const TAB_FROM_HASH: Record<string, TabType> = {
  credentials: "overview",
  "credentials/list": "list",
  "credentials/providers": "providers",
  "credentials/oauth": "oauth",
  "credentials/pool": "pool",
  "credentials/health": "health",
  "credentials/quota": "quota",
  "credentials/policies": "policies",
  "credentials/approvals": "approvals",
  "credentials/audit": "audit",
};

function readTabFromHash(): TabType {
  const raw = normalizeHashPath(typeof window !== "undefined" ? window.location.hash : "credentials");
  return TAB_FROM_HASH[raw] ?? "overview";
}

function hashForTab(tab: TabType): string {
  return tab === "overview" ? "credentials" : `credentials/${tab}`;
}

interface Overview {
  enabled: boolean;
  total: number;
  healthy: number;
  degraded: number;
  quarantined: number;
  revoked: number;
  active_leases: number;
  circuit_open: number;
  vault_available: boolean;
}

type Row = Record<string, unknown>;

interface CredentialsWorkspace {
  overview: Overview | null;
  credentials: Row[];
  providers: Row[];
  oauth: Row[];
  pool: Row[];
  health: Row[];
  quota: Row[];
  policies: Row[];
  approvals: Row[];
  audit: Row[];
}

const EMPTY_WORKSPACE: CredentialsWorkspace = {
  overview: null,
  credentials: [],
  providers: [],
  oauth: [],
  pool: [],
  health: [],
  quota: [],
  policies: [],
  approvals: [],
  audit: [],
};

const TABS: Array<{ id: TabType; labelKey: TKey }> = [
  { id: "overview", labelKey: "credentials.tab.overview" },
  { id: "list", labelKey: "credentials.tab.list" },
  { id: "providers", labelKey: "credentials.tab.providers" },
  { id: "oauth", labelKey: "credentials.tab.oauth" },
  { id: "pool", labelKey: "credentials.tab.pool" },
  { id: "health", labelKey: "credentials.tab.health" },
  { id: "quota", labelKey: "credentials.tab.quota" },
  { id: "policies", labelKey: "credentials.tab.policies" },
  { id: "approvals", labelKey: "credentials.tab.approvals" },
  { id: "audit", labelKey: "credentials.tab.audit" },
];

async function readData<T>(res: Response, fallback: T): Promise<T> {
  const payload = await readJsonIfOk<{ data?: T }>(res);
  return payload?.data ?? fallback;
}

function cell(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function Credentials({ apiBase }: CredentialsProps): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<TabType>(readTabFromHash);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const selectTab = (next: TabType) => {
    setTab(next);
    navigateHash(hashForTab(next));
  };

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadWorkspace = useCallback(async (signal: AbortSignal): Promise<CredentialsWorkspace> => {
    const [
      overviewRes,
      credentialsRes,
      providersRes,
      oauthRes,
      poolRes,
      healthRes,
      quotaRes,
      policiesRes,
      approvalsRes,
      auditRes,
    ] = await Promise.all([
      fetch(`${apiBase}/api/credentials/overview`, { signal }),
      fetch(`${apiBase}/api/credentials`, { signal }),
      fetch(`${apiBase}/api/credentials/providers`, { signal }),
      fetch(`${apiBase}/api/credentials/oauth/sessions`, { signal }),
      fetch(`${apiBase}/api/credentials/pool`, { signal }),
      fetch(`${apiBase}/api/credentials/health`, { signal }),
      fetch(`${apiBase}/api/credentials/quota`, { signal }),
      fetch(`${apiBase}/api/credentials/policies`, { signal }),
      fetch(`${apiBase}/api/credentials/approvals`, { signal }),
      fetch(`${apiBase}/api/credentials/audit`, { signal }),
    ]);
    return {
      overview: await readData<Overview | null>(overviewRes, null),
      credentials: await readData<Row[]>(credentialsRes, []),
      providers: await readData<Row[]>(providersRes, []),
      oauth: await readData<Row[]>(oauthRes, []),
      pool: await readData<Row[]>(poolRes, []),
      health: await readData<Row[]>(healthRes, []),
      quota: await readData<Row[]>(quotaRes, []),
      policies: await readData<Row[]>(policiesRes, []),
      approvals: await readData<Row[]>(approvalsRes, []),
      audit: await readData<Row[]>(auditRes, []),
    };
  }, [apiBase]);

  const resource = useDataSurface<CredentialsWorkspace>(
    `credentials-workspace:${apiBase}`,
    [apiBase],
    loadWorkspace,
    { isEmpty: () => false },
  );
  const workspace = resource.state.data ?? EMPTY_WORKSPACE;
  const {
    overview,
    credentials,
    providers,
    oauth,
    pool,
    health,
    quota,
    policies,
    approvals,
    audit,
  } = workspace;
  const loading = resource.state.refreshing || resource.state.showSkeleton;
  const hashList = useMemo(() => ["credentials", ...CREDENTIALS_TAB_HASHES].join(", "), []);

  const post = async (path: string, body?: Record<string, unknown>) => {
    try {
      setStatusMessage(t("credentials.status.posting", { path }));
      const res = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? { actor: "gui-operator" }),
      });
      const data = await res.json().catch(() => ({})) as { error?: unknown };
      const error = typeof data.error === "string" ? data.error : String(res.status);
      setStatusMessage(res.ok ? t("credentials.status.ok", { path }) : t("credentials.status.failed", { error }));
      resource.refresh();
    } catch (e) {
      setStatusMessage(t("credentials.status.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <div className="credentials-workspace">
      <div className="credentials-header">
        <div className="credentials-title-group">
          <h1>{t("credentials.title")}</h1>
          <p className="credentials-subtitle">{t("credentials.subtitle")}</p>
        </div>
        <button className="credentials-tab-btn" type="button" onClick={() => resource.refresh()} disabled={loading}>
          {loading ? t("credentials.refreshing") : t("credentials.refresh")}
        </button>
      </div>

      <div className="credentials-banner">
        {t("credentials.banner")}
        {overview && !overview.enabled ? ` ${t("credentials.flagOff")}` : ""}
      </div>

      {resource.state.showError && <div className="credentials-banner">{t("credentials.loadFailed")}</div>}
      {statusMessage && <div className="credentials-banner">{statusMessage}</div>}

      <div className="credentials-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={`credentials-tab-btn ${tab === entry.id ? "active" : ""}`}
            onClick={() => selectTab(entry.id)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === "overview" && overview && (
        <>
          <div className="credentials-overview-grid">
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.enabled")}</span><span className="credentials-card-val">{overview.enabled ? t("credentials.yes") : t("credentials.no")}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.total")}</span><span className="credentials-card-val">{overview.total}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.healthy")}</span><span className="credentials-card-val">{overview.healthy}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.degraded")}</span><span className="credentials-card-val">{overview.degraded}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.quarantined")}</span><span className="credentials-card-val">{overview.quarantined}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.revoked")}</span><span className="credentials-card-val">{overview.revoked}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.leases")}</span><span className="credentials-card-val">{overview.active_leases}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.breakers")}</span><span className="credentials-card-val">{overview.circuit_open}</span></div>
            <div className="credentials-card"><span className="credentials-card-label">{t("credentials.card.vault")}</span><span className="credentials-card-val">{overview.vault_available ? t("credentials.available") : t("credentials.unavailable")}</span></div>
          </div>
          <div className="credentials-actions">
            <button type="button" className="credentials-tab-btn" onClick={() => void post("/api/credentials/health/run")}>{t("credentials.healthRun")}</button>
          </div>
        </>
      )}

      {tab === "list" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.name")}</th><th>{t("credentials.col.provider")}</th><th>{t("credentials.col.status")}</th><th>{t("credentials.col.health")}</th><th>{t("credentials.col.secret")}</th><th>{t("credentials.col.eligible")}</th><th>{t("credentials.col.actions")}</th></tr></thead>
          <tbody>
            {credentials.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td>{cell(row.name)}</td>
                <td><code>{cell(row.provider_slug)}</code></td>
                <td><code>{cell(row.status)}</code></td>
                <td><code>{cell(row.health_status)}</code></td>
                <td><code>{cell(row.secret)}</code></td>
                <td>{row.routing_eligible === true ? t("credentials.yes") : t("credentials.no")}</td>
                <td className="credentials-actions">
                  <button type="button" className="credentials-tab-btn" onClick={() => void post(`/api/credentials/${encodeURIComponent(cell(row.id))}/validate`)}>{t("credentials.validate")}</button>
                  <button type="button" className="credentials-tab-btn" onClick={() => void post(`/api/credentials/${encodeURIComponent(cell(row.id))}/quarantine`)}>{t("credentials.quarantine")}</button>
                  <button type="button" className="credentials-tab-btn" onClick={() => void post(`/api/credentials/${encodeURIComponent(cell(row.id))}/revoke`)}>{t("credentials.revoke")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "providers" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.name")}</th><th>{t("credentials.col.adapter")}</th><th>{t("credentials.col.oauth")}</th><th>{t("credentials.col.enabled")}</th></tr></thead>
          <tbody>
            {providers.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.slug)}</code></td>
                <td>{cell(row.name)}</td>
                <td><code>{cell(row.adapter_type)}</code></td>
                <td>{row.oauth_supported === true ? t("credentials.yes") : t("credentials.no")}</td>
                <td>{row.enabled === true ? t("credentials.yes") : t("credentials.no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "oauth" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.session")}</th><th>{t("credentials.col.status")}</th><th>{t("credentials.col.redirect")}</th></tr></thead>
          <tbody>
            {oauth.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td><code>{cell(row.status)}</code></td>
                <td><code>{cell(row.redirect_uri)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "pool" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.provider")}</th><th>{t("credentials.col.score")}</th><th>{t("credentials.col.health")}</th><th>{t("credentials.col.status")}</th></tr></thead>
          <tbody>
            {pool.map(row => (
              <tr key={cell(row.credential_id)}>
                <td><code>{cell(row.credential_id)}</code></td>
                <td><code>{cell(row.provider)}</code></td>
                <td>{cell(row.routing_score)}</td>
                <td><code>{cell(row.health_status)}</code></td>
                <td><code>{cell(row.status)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "health" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.health")}</th><th>{t("credentials.col.score")}</th><th>{t("credentials.col.status")}</th><th>{t("credentials.col.eligible")}</th></tr></thead>
          <tbody>
            {health.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td><code>{cell(row.health_status)}</code></td>
                <td>{cell(row.health_score)}</td>
                <td><code>{cell(row.status)}</code></td>
                <td>{row.routing_eligible === true ? t("credentials.yes") : t("credentials.no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "quota" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.budget")}</th><th>{t("credentials.col.health")}</th></tr></thead>
          <tbody>
            {quota.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td><code>{`${cell(row.remaining_budget)} / ${cell(row.budget_limit)}`}</code></td>
                <td><code>{cell(row.health_status)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "policies" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.name")}</th><th>{t("credentials.col.priority")}</th></tr></thead>
          <tbody>
            {policies.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td>{cell(row.name)}</td>
                <td>{cell(row.priority)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "approvals" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.id")}</th><th>{t("credentials.col.action")}</th><th>{t("credentials.col.target")}</th><th>{t("credentials.col.status")}</th><th>{t("credentials.col.actions")}</th></tr></thead>
          <tbody>
            {approvals.map(row => (
              <tr key={cell(row.id)}>
                <td><code>{cell(row.id)}</code></td>
                <td><code>{cell(row.action)}</code></td>
                <td><code>{cell(row.target_id)}</code></td>
                <td><code>{cell(row.status)}</code></td>
                <td className="credentials-actions">
                  <button type="button" className="credentials-tab-btn" onClick={() => void post(`/api/credentials/approvals/${encodeURIComponent(cell(row.id))}/approve`)}>{t("credentials.approve")}</button>
                  <button type="button" className="credentials-tab-btn" onClick={() => void post(`/api/credentials/approvals/${encodeURIComponent(cell(row.id))}/reject`)}>{t("credentials.reject")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "audit" && (
        <table className="credentials-table">
          <thead><tr><th>{t("credentials.col.when")}</th><th>{t("credentials.col.event")}</th><th>{t("credentials.col.actor")}</th><th>{t("credentials.col.decision")}</th></tr></thead>
          <tbody>
            {audit.map(row => (
              <tr key={cell(row.id)}>
                <td>{cell(row.created_at)}</td>
                <td><code>{cell(row.action)}</code></td>
                <td>{cell(row.actor_id)}</td>
                <td>{cell(row.decision)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="credentials-subtitle">{t("credentials.hashes", { hashes: hashList })}</p>
    </div>
  );
}

