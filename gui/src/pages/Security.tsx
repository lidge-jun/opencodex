import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../styles-security-workspace.css";
import { SECURITY_TAB_HASHES } from "../app-routing";
import { useDataSurface } from "../data-surface";
import { readJsonIfOk } from "../fetch-json";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";

export interface SecurityProps {
  apiBase: string;
}

type TabType =
  | "overview"
  | "authorizations"
  | "scopes"
  | "campaigns"
  | "approvals"
  | "findings"
  | "evidence"
  | "skills"
  | "tools"
  | "mcp"
  | "policies"
  | "audit";

const TAB_FROM_HASH: Record<string, TabType> = {
  security: "overview",
  "security/authorizations": "authorizations",
  "security/scopes": "scopes",
  "security/campaigns": "campaigns",
  "security/approvals": "approvals",
  "security/findings": "findings",
  "security/evidence": "evidence",
  "security/skills": "skills",
  "security/tools": "tools",
  "security/mcp": "mcp",
  "security/policies": "policies",
  "security/audit": "audit",
};

function readTabFromHash(): TabType {
  const raw = normalizeHashPath(typeof window !== "undefined" ? window.location.hash : "security");
  return TAB_FROM_HASH[raw] ?? "overview";
}

function hashForTab(tab: TabType): string {
  return tab === "overview" ? "security" : `security/${tab}`;
}

interface Overview {
  enabled: boolean;
  campaigns_active: number;
  approvals_pending: number;
  leads_open: number;
  findings_validated: number;
  blocked_actions: number;
  authorizations_expiring: number;
  circuit_breakers_open: number;
}

type Row = Record<string, unknown>;

interface SecurityWorkspace {
  overview: Overview | null;
  authorizations: Row[];
  scopes: Row[];
  campaigns: Row[];
  approvals: Row[];
  findings: Row[];
  evidence: Row[];
  packages: Row[];
  tools: Row[];
  mcp: Row[];
  policies: Row[];
  audit: Row[];
}

const EMPTY_WORKSPACE: SecurityWorkspace = {
  overview: null,
  authorizations: [],
  scopes: [],
  campaigns: [],
  approvals: [],
  findings: [],
  evidence: [],
  packages: [],
  tools: [],
  mcp: [],
  policies: [],
  audit: [],
};

const TABS: Array<{ id: TabType; labelKey: TKey }> = [
  { id: "overview", labelKey: "security.tab.overview" },
  { id: "authorizations", labelKey: "security.tab.authorizations" },
  { id: "scopes", labelKey: "security.tab.scopes" },
  { id: "campaigns", labelKey: "security.tab.campaigns" },
  { id: "approvals", labelKey: "security.tab.approvals" },
  { id: "findings", labelKey: "security.tab.findings" },
  { id: "evidence", labelKey: "security.tab.evidence" },
  { id: "skills", labelKey: "security.tab.skills" },
  { id: "tools", labelKey: "security.tab.tools" },
  { id: "mcp", labelKey: "security.tab.mcp" },
  { id: "policies", labelKey: "security.tab.policies" },
  { id: "audit", labelKey: "security.tab.audit" },
];

async function readData<T>(res: Response, fallback: T): Promise<T> {
  const payload = await readJsonIfOk<{ data?: T }>(res);
  return payload?.data ?? fallback;
}

export function Security({ apiBase }: SecurityProps): React.JSX.Element {
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

  const loadWorkspace = useCallback(async (signal: AbortSignal): Promise<SecurityWorkspace> => {
    const [
      overviewRes,
      authorizationsRes,
      scopesRes,
      campaignsRes,
      approvalsRes,
      findingsRes,
      packagesRes,
      toolsRes,
      mcpRes,
      policiesRes,
      auditRes,
    ] = await Promise.all([
      fetch(`${apiBase}/api/security/overview`, { signal }),
      fetch(`${apiBase}/api/security/authorizations`, { signal }),
      fetch(`${apiBase}/api/security/scopes`, { signal }),
      fetch(`${apiBase}/api/security/campaigns`, { signal }),
      fetch(`${apiBase}/api/security/approvals`, { signal }),
      fetch(`${apiBase}/api/security/findings`, { signal }),
      fetch(`${apiBase}/api/security/skills`, { signal }),
      fetch(`${apiBase}/api/security/tools`, { signal }),
      fetch(`${apiBase}/api/security/mcp`, { signal }),
      fetch(`${apiBase}/api/security/policies`, { signal }),
      fetch(`${apiBase}/api/security/audit`, { signal }),
    ]);
    const campaigns = await readData<Row[]>(campaignsRes, []);
    const campaignId = typeof campaigns[0]?.id === "string" ? campaigns[0].id : "";
    const evidence = campaignId
      ? await readData<Row[]>(
        await fetch(`${apiBase}/api/security/campaigns/${encodeURIComponent(campaignId)}/evidence`, { signal }),
        [],
      )
      : [];
    return {
      overview: await readData<Overview | null>(overviewRes, null),
      authorizations: await readData<Row[]>(authorizationsRes, []),
      scopes: await readData<Row[]>(scopesRes, []),
      campaigns,
      approvals: await readData<Row[]>(approvalsRes, []),
      findings: await readData<Row[]>(findingsRes, []),
      evidence,
      packages: await readData<Row[]>(packagesRes, []),
      tools: await readData<Row[]>(toolsRes, []),
      mcp: await readData<Row[]>(mcpRes, []),
      policies: await readData<Row[]>(policiesRes, []),
      audit: await readData<Row[]>(auditRes, []),
    };
  }, [apiBase]);

  const resource = useDataSurface<SecurityWorkspace>(
    `security-workspace:${apiBase}`,
    [apiBase],
    loadWorkspace,
    { isEmpty: () => false },
  );
  const workspace = resource.state.data ?? EMPTY_WORKSPACE;
  const {
    overview,
    authorizations,
    scopes,
    campaigns,
    approvals,
    findings,
    evidence,
    packages,
    tools,
    mcp,
    policies,
    audit,
  } = workspace;
  const loading = resource.state.refreshing || resource.state.showSkeleton;
  const hashList = useMemo(() => ["security", ...SECURITY_TAB_HASHES].join(", "), []);

  const post = async (path: string, body?: Record<string, unknown>) => {
    setStatusMessage(t("security.status.posting", { path }));
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? { actor: "gui-reviewer" }),
    });
    const data = await res.json().catch(() => ({})) as { error?: unknown };
    const error = typeof data.error === "string" ? data.error : String(res.status);
    setStatusMessage(res.ok ? t("security.status.ok", { path }) : t("security.status.failed", { error }));
    resource.refresh();
  };

  return (
    <div className="security-workspace">
      <div className="security-header">
        <div className="security-title-group">
          <h1>{t("security.title")}</h1>
          <p className="security-subtitle">{t("security.subtitle")}</p>
        </div>
        <button className="security-tab-btn" type="button" onClick={() => resource.refresh()} disabled={loading}>
          {loading ? t("security.refreshing") : t("security.refresh")}
        </button>
      </div>

      <div className="security-banner">
        {t("security.banner")}
        {overview && !overview.enabled ? ` ${t("security.flagOff")}` : ""}
      </div>

      {statusMessage && <div className="security-banner">{statusMessage}</div>}

      <div className="security-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={`security-tab-btn ${tab === entry.id ? "active" : ""}`}
            onClick={() => selectTab(entry.id)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === "overview" && overview && (
        <div className="security-overview-grid">
          <div className="security-card"><span className="security-card-label">{t("security.card.enabled")}</span><span className="security-card-val">{overview.enabled ? t("security.yes") : t("security.no")}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.campaigns")}</span><span className="security-card-val">{overview.campaigns_active}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.approvals")}</span><span className="security-card-val">{overview.approvals_pending}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.leads")}</span><span className="security-card-val">{overview.leads_open}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.validated")}</span><span className="security-card-val">{overview.findings_validated}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.blocked")}</span><span className="security-card-val">{overview.blocked_actions}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.authExpiring")}</span><span className="security-card-val">{overview.authorizations_expiring}</span></div>
          <div className="security-card"><span className="security-card-label">{t("security.card.breakers")}</span><span className="security-card-val">{overview.circuit_breakers_open}</span></div>
        </div>
      )}

      {tab === "authorizations" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.type")}</th><th>{t("security.col.status")}</th><th>{t("security.col.validUntil")}</th></tr></thead>
          <tbody>
            {authorizations.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.type)}</td>
                <td>{String(row.status)}</td>
                <td>{String(row.valid_until)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "scopes" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.status")}</th></tr></thead>
          <tbody>
            {scopes.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "campaigns" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.status")}</th><th>{t("security.col.actions")}</th></tr></thead>
          <tbody>
            {campaigns.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.status)}</td>
                <td className="security-actions">
                  <button type="button" className="security-tab-btn" onClick={() => void post(`/api/security/campaigns/${encodeURIComponent(String(row.id))}/start`)}>{t("security.start")}</button>
                  <button type="button" className="security-tab-btn" onClick={() => void post(`/api/security/campaigns/${encodeURIComponent(String(row.id))}/pause`)}>{t("security.pause")}</button>
                  <button type="button" className="security-tab-btn" onClick={() => void post(`/api/security/campaigns/${encodeURIComponent(String(row.id))}/recon`, { target: "lab.local", actor: "gui-operator" })}>{t("security.reconLab")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "approvals" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.target")}</th><th>{t("security.col.status")}</th><th>{t("security.col.actions")}</th></tr></thead>
          <tbody>
            {approvals.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.target)}</td>
                <td>{String(row.status)}</td>
                <td className="security-actions">
                  <button type="button" className="security-tab-btn" onClick={() => void post(`/api/security/approvals/${encodeURIComponent(String(row.id))}/approve`, { actor: "gui-reviewer", reason: t("security.reasonBounded") })}>{t("security.approveOnce")}</button>
                  <button type="button" className="security-tab-btn" onClick={() => void post(`/api/security/approvals/${encodeURIComponent(String(row.id))}/deny`, { actor: "gui-reviewer", reason: t("security.reasonDenied") })}>{t("security.deny")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "findings" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.title")}</th><th>{t("security.col.status")}</th><th>{t("security.col.severity")}</th></tr></thead>
          <tbody>
            {findings.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.title)}</td>
                <td>{String(row.status)}</td>
                <td>{String(row.severity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "evidence" && (
        <>
          <div className="security-banner">
            {campaigns[0] ? `Campaign evidence: ${String(campaigns[0].name ?? campaigns[0].id)}` : "No active campaign"}
          </div>
          <table className="security-table">
            <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.type")}</th><th>{t("security.col.sha256")}</th><th>{t("security.col.preview")}</th></tr></thead>
            <tbody>
              {evidence.map(row => (
                <tr key={String(row.id)}>
                  <td>{String(row.id)}</td>
                  <td>{String(row.type)}</td>
                  <td>{String(row.sha256).slice(0, 12)}…</td>
                  <td>{String(row.redacted_preview ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "skills" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.compatibility")}</th></tr></thead>
          <tbody>
            {packages.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.compatibility)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "tools" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.kind")}</th><th>{t("security.col.allowlisted")}</th></tr></thead>
          <tbody>
            {tools.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.kind)}</td>
                <td>{String(row.allowlisted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "mcp" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.health")}</th><th>{t("security.col.credential")}</th></tr></thead>
          <tbody>
            {mcp.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.health_state)}</td>
                <td>{String(row.credential_ref ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "policies" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.id")}</th><th>{t("security.col.name")}</th><th>{t("security.col.ceiling")}</th><th>{t("security.col.blockR3")}</th></tr></thead>
          <tbody>
            {policies.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.id)}</td>
                <td>{String(row.name)}</td>
                <td>{String(row.default_risk_ceiling)}</td>
                <td>{String(row.block_r3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "audit" && (
        <table className="security-table">
          <thead><tr><th>{t("security.col.when")}</th><th>{t("security.col.event")}</th><th>{t("security.col.actor")}</th><th>{t("security.col.target")}</th></tr></thead>
          <tbody>
            {audit.map(row => (
              <tr key={String(row.id)}>
                <td>{String(row.created_at)}</td>
                <td>{String(row.event_type)}</td>
                <td>{String(row.actor_id)}</td>
                <td>{String(row.target ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="security-subtitle">{t("security.hashes", { hashes: hashList })}</p>
    </div>
  );
}
