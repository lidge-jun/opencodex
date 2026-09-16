import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../styles-social-workspace.css";
import { SOCIAL_TAB_HASHES } from "../app-routing";
import { useDataSurface } from "../data-surface";
import { readJsonIfOk } from "../fetch-json";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";

export interface SocialProps {
  apiBase: string;
}

type TabType =
  | "overview"
  | "accounts"
  | "publications"
  | "approvals"
  | "jobs"
  | "analytics"
  | "instances"
  | "audit";

const TAB_FROM_HASH: Record<string, TabType> = {
  social: "overview",
  "social/accounts": "accounts",
  "social/publications": "publications",
  "social/approvals": "approvals",
  "social/jobs": "jobs",
  "social/analytics": "analytics",
  "social/instances": "instances",
  "social/audit": "audit",
};

function readTabFromHash(): TabType {
  const raw = normalizeHashPath(typeof window !== "undefined" ? window.location.hash : "social");
  return TAB_FROM_HASH[raw] ?? "overview";
}

function hashForTab(tab: TabType): string {
  return tab === "overview" ? "social" : `social/${tab}`;
}

interface OverviewData {
  enabled: boolean;
  instances_count: number;
  accounts_count: number;
  ready_accounts_count: number;
  publications_count: number;
  scheduled_count: number;
  pending_approvals_count: number;
  failed_deliveries_count: number;
}

type Row = Record<string, unknown>;

interface SocialWorkspace {
  overview: OverviewData | null;
  accounts: Row[];
  publications: Row[];
  approvals: Row[];
  jobs: Row[];
  analytics: Row[];
  instances: Row[];
  audit: Row[];
}

const EMPTY_WORKSPACE: SocialWorkspace = {
  overview: null,
  accounts: [],
  publications: [],
  approvals: [],
  jobs: [],
  analytics: [],
  instances: [],
  audit: [],
};

const TABS: Array<{ id: TabType; labelKey: TKey }> = [
  { id: "overview", labelKey: "social.tab.overview" },
  { id: "accounts", labelKey: "social.tab.accounts" },
  { id: "publications", labelKey: "social.tab.publications" },
  { id: "approvals", labelKey: "social.tab.approvals" },
  { id: "jobs", labelKey: "social.tab.jobs" },
  { id: "analytics", labelKey: "social.tab.analytics" },
  { id: "instances", labelKey: "social.tab.instances" },
  { id: "audit", labelKey: "social.tab.audit" },
];

async function readData<T>(res: Response, fallback: T): Promise<T> {
  const payload = await readJsonIfOk<{ data?: T }>(res);
  return payload?.data ?? fallback;
}

function cell(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

export function Social({ apiBase }: SocialProps): React.JSX.Element {
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

  const loadWorkspace = useCallback(async (signal: AbortSignal): Promise<SocialWorkspace> => {
    const [overviewRes, accRes, pubRes, jobsRes, instRes, auditRes] = await Promise.all([
      fetch(`${apiBase}/api/social/overview`, { signal }),
      fetch(`${apiBase}/api/social/accounts`, { signal }),
      fetch(`${apiBase}/api/social/publications`, { signal }),
      fetch(`${apiBase}/api/social/jobs`, { signal }),
      fetch(`${apiBase}/api/social/openpost/instances`, { signal }),
      fetch(`${apiBase}/api/social/audit`, { signal }),
    ]);

    return {
      overview: await readData<OverviewData | null>(overviewRes, null),
      accounts: await readData<Row[]>(accRes, []),
      publications: await readData<Row[]>(pubRes, []),
      approvals: [],
      jobs: await readData<Row[]>(jobsRes, []),
      analytics: [],
      instances: await readData<Row[]>(instRes, []),
      audit: await readData<Row[]>(auditRes, []),
    };
  }, [apiBase]);

  const resource = useDataSurface<SocialWorkspace>(
    `social-workspace:${apiBase}`,
    [apiBase],
    loadWorkspace,
    { isEmpty: ws => !ws.overview && ws.accounts.length === 0 },
  );

  const workspace = resource.state.data ?? EMPTY_WORKSPACE;
  const overview = workspace.overview;

  const triggerPost = async (path: string, body?: unknown) => {
    try {
      setStatusMessage(t("social.status.posting", { path }));
      const res = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(String(data.error ?? res.statusText));
      setStatusMessage(t("social.status.ok", { path }));
      resource.refresh();
    } catch (err) {
      setStatusMessage(t("social.status.failed", { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const hashList = useMemo(() => ["social", ...SOCIAL_TAB_HASHES].join(", "), []);

  return (
    <div className="social-workspace" data-testid="social-workspace">
      <header className="social-header">
        <div className="social-title-group">
          <h1>{t("social.title")}</h1>
          <p className="social-subtitle">{t("social.subtitle")}</p>
        </div>
        <div className="social-actions">
          <button
            type="button"
            className="social-btn"
            disabled={resource.state.refreshing}
            onClick={() => resource.refresh()}
          >
            {resource.state.refreshing ? t("social.refreshing") : t("social.refresh")}
          </button>
        </div>
      </header>

      {statusMessage && <div className="alert alert-info">{statusMessage}</div>}

      <div className="alert alert-warning">{t("social.banner")}</div>

      {overview && !overview.enabled && (
        <div className="alert alert-err">{t("social.flagOff")}</div>
      )}

      <nav className="social-tabs" role="tablist" aria-label="Social publishing tabs">
        {TABS.map(tabDef => (
          <button
            key={tabDef.id}
            type="button"
            role="tab"
            aria-selected={tab === tabDef.id}
            className={`social-tab${tab === tabDef.id ? " active" : ""}`}
            onClick={() => selectTab(tabDef.id)}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>

      {tab === "overview" && overview && (
        <div className="social-cards">
          <div className="social-card">
            <span className="social-card-label">{t("social.card.enabled")}</span>
            <span className="social-card-value">{overview.enabled ? t("social.yes") : t("social.no")}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.instances")}</span>
            <span className="social-card-value">{overview.instances_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.accounts")}</span>
            <span className="social-card-value">{overview.accounts_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.readyAccounts")}</span>
            <span className="social-card-value">{overview.ready_accounts_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.publications")}</span>
            <span className="social-card-value">{overview.publications_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.scheduled")}</span>
            <span className="social-card-value">{overview.scheduled_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.pendingApprovals")}</span>
            <span className="social-card-value">{overview.pending_approvals_count}</span>
          </div>
          <div className="social-card">
            <span className="social-card-label">{t("social.card.failedDeliveries")}</span>
            <span className="social-card-value">{overview.failed_deliveries_count}</span>
          </div>
        </div>
      )}

      {tab === "accounts" && (
        <div className="social-table-container">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t("social.col.id")}</th>
                <th>{t("social.col.platform")}</th>
                <th>{t("social.col.displayName")}</th>
                <th>{t("social.col.readiness")}</th>
                <th>{t("social.col.enabled")}</th>
                <th>{t("social.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.accounts.length === 0 ? (
                <tr><td colSpan={6} className="social-empty">{t("social.emptyAccounts")}</td></tr>
              ) : (
                workspace.accounts.map(acc => (
                  <tr key={cell(acc.id)}>
                    <td><code>{cell(acc.id)}</code></td>
                    <td><span className="social-badge">{cell(acc.platform)}</span></td>
                    <td>{cell(acc.display_name ?? acc.username)}</td>
                    <td>
                      <span className={`social-badge ${cell(acc.readiness_state).toLowerCase()}`}>
                        {cell(acc.readiness_state)}
                      </span>
                    </td>
                    <td>{acc.enabled ? t("social.yes") : t("social.no")}</td>
                    <td>
                      <button
                        type="button"
                        className="social-btn"
                        onClick={() => triggerPost(`/api/social/accounts/${cell(acc.id)}/refresh-capabilities`)}
                      >
                        {t("social.refreshCaps")}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "publications" && (
        <div className="social-table-container">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t("social.col.id")}</th>
                <th>{t("social.col.sourceType")}</th>
                <th>{t("social.col.title")}</th>
                <th>{t("social.col.status")}</th>
                <th>{t("social.col.scheduledAt")}</th>
                <th>{t("social.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.publications.length === 0 ? (
                <tr><td colSpan={6} className="social-empty">{t("social.emptyPublications")}</td></tr>
              ) : (
                workspace.publications.map(pub => (
                  <tr key={cell(pub.id)}>
                    <td><code>{cell(pub.id)}</code></td>
                    <td>{cell(pub.source_type)}</td>
                    <td>{cell(pub.master_title ?? pub.master_caption)}</td>
                    <td>
                      <span className={`social-badge ${cell(pub.status).toLowerCase()}`}>
                        {cell(pub.status)}
                      </span>
                    </td>
                    <td>{cell(pub.scheduled_at)}</td>
                    <td>
                      <div className="social-actions">
                        <button
                          type="button"
                          className="social-btn"
                          onClick={() => triggerPost(`/api/social/publications/${cell(pub.id)}/validate`)}
                        >
                          {t("social.validate")}
                        </button>
                        <button
                          type="button"
                          className="social-btn primary"
                          onClick={() => triggerPost(`/api/social/publications/${cell(pub.id)}/approve`)}
                        >
                          {t("social.approve")}
                        </button>
                        <button
                          type="button"
                          className="social-btn"
                          onClick={() => triggerPost(`/api/social/publications/${cell(pub.id)}/publish`)}
                        >
                          {t("social.publish")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "instances" && (
        <div className="social-table-container">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t("social.col.id")}</th>
                <th>{t("social.col.name")}</th>
                <th>{t("social.col.baseUrl")}</th>
                <th>{t("social.col.status")}</th>
                <th>{t("social.col.version")}</th>
                <th>{t("social.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.instances.length === 0 ? (
                <tr><td colSpan={6} className="social-empty">{t("social.emptyInstances")}</td></tr>
              ) : (
                workspace.instances.map(inst => (
                  <tr key={cell(inst.id)}>
                    <td><code>{cell(inst.id)}</code></td>
                    <td>{cell(inst.name)}</td>
                    <td><code>{cell(inst.base_url)}</code></td>
                    <td>
                      <span className={`social-badge ${cell(inst.status).toLowerCase()}`}>
                        {cell(inst.status)}
                      </span>
                    </td>
                    <td>{cell(inst.version)}</td>
                    <td>
                      <div className="social-actions">
                        <button
                          type="button"
                          className="social-btn"
                          onClick={() => triggerPost(`/api/social/openpost/instances/${cell(inst.id)}/test`)}
                        >
                          {t("social.test")}
                        </button>
                        <button
                          type="button"
                          className="social-btn primary"
                          onClick={() => triggerPost(`/api/social/openpost/instances/${cell(inst.id)}/sync`)}
                        >
                          {t("social.syncAccounts")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "jobs" && (
        <div className="social-table-container">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t("social.col.id")}</th>
                <th>{t("social.col.pubId")}</th>
                <th>{t("social.col.jobType")}</th>
                <th>{t("social.col.status")}</th>
                <th>{t("social.col.attempts")}</th>
                <th>{t("social.col.error")}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.jobs.length === 0 ? (
                <tr><td colSpan={6} className="social-empty">{t("social.emptyJobs")}</td></tr>
              ) : (
                workspace.jobs.map(job => (
                  <tr key={cell(job.id)}>
                    <td><code>{cell(job.id)}</code></td>
                    <td><code>{cell(job.publication_id)}</code></td>
                    <td>{cell(job.job_type)}</td>
                    <td>
                      <span className={`social-badge ${cell(job.status).toLowerCase()}`}>
                        {cell(job.status)}
                      </span>
                    </td>
                    <td>{cell(job.attempt_count)}/{cell(job.max_attempts)}</td>
                    <td>{cell(job.last_error_message)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "audit" && (
        <div className="social-table-container">
          <table className="social-table">
            <thead>
              <tr>
                <th>{t("social.col.when")}</th>
                <th>{t("social.col.actor")}</th>
                <th>{t("social.col.action")}</th>
                <th>{t("social.col.resource")}</th>
                <th>{t("social.col.resourceId")}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.audit.length === 0 ? (
                <tr><td colSpan={5} className="social-empty">{t("social.emptyAudit")}</td></tr>
              ) : (
                workspace.audit.map(ev => (
                  <tr key={cell(ev.id)}>
                    <td>{cell(ev.timestamp)}</td>
                    <td>{cell(ev.actor_type)}:{cell(ev.actor_id)}</td>
                    <td><code>{cell(ev.action)}</code></td>
                    <td>{cell(ev.resource_type)}</td>
                    <td><code>{cell(ev.resource_id)}</code></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <footer className="social-footer">
        <p className="social-subtitle">{t("social.hashes", { hashes: hashList })}</p>
      </footer>
    </div>
  );
}

