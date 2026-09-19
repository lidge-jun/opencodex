import React, { useCallback, useEffect, useState } from "react";
import { useDataSurface } from "../data-surface";
import { readJsonIfOk } from "../fetch-json";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT, type TKey } from "../i18n/shared";
import "../styles-skills-workspace.css";

export interface SkillsProps {
  apiBase: string;
}

type TabType =
  | "overview"
  | "marketplace"
  | "registry"
  | "editor"
  | "matrix"
  | "agents"
  | "nodes"
  | "drift"
  | "reviews"
  | "audit";

interface SkillItem {
  id: string;
  namespace: string;
  slug: string;
  display_name: string;
  description: string;
  status: string;
  current_version: string;
  trust_level: string;
  risk_level?: string;
  tags: string[];
}

interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  tags: string[];
  sourceUrl: string;
  verified: boolean;
}

interface DeploymentItem {
  id: string;
  skill_version_id: string;
  node_id: string;
  agent_id: string;
  scope: string;
  target_path: string;
  status: string;
  desired_sha256: string;
  actual_sha256?: string;
}

interface AuditEventItem {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id?: string;
  skill_id?: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

const TAB_FROM_HASH: Record<string, TabType> = {
  skills: "overview",
  "skills/marketplace": "marketplace",
  "skills/registry": "registry",
  "skills/editor": "editor",
  "skills/matrix": "matrix",
  "skills/agents": "agents",
  "skills/nodes": "nodes",
  "skills/drift": "drift",
  "skills/reviews": "reviews",
  "skills/audit": "audit",
};

function readTabFromHash(): TabType {
  const raw = normalizeHashPath(typeof window !== "undefined" ? window.location.hash : "skills");
  return TAB_FROM_HASH[raw] ?? "overview";
}

function hashForTab(tab: TabType): string {
  return tab === "overview" ? "skills" : `skills/${tab}`;
}

interface SkillsWorkspace {
  skills: SkillItem[];
  marketplaceItems: MarketplaceItem[];
  deployments: DeploymentItem[];
  auditEvents: AuditEventItem[];
}

const EMPTY_WORKSPACE: SkillsWorkspace = {
  skills: [],
  marketplaceItems: [],
  deployments: [],
  auditEvents: [],
};

const TABS: Array<{ id: TabType; labelKey: TKey; count?: boolean }> = [
  { id: "overview", labelKey: "skills.tab.overview" },
  { id: "marketplace", labelKey: "skills.tab.marketplace" },
  { id: "registry", labelKey: "skills.tab.registry", count: true },
  { id: "editor", labelKey: "skills.tab.editor" },
  { id: "matrix", labelKey: "skills.tab.matrix" },
  { id: "agents", labelKey: "skills.tab.agents" },
  { id: "nodes", labelKey: "skills.tab.nodes" },
  { id: "drift", labelKey: "skills.tab.drift" },
  { id: "reviews", labelKey: "skills.tab.reviews" },
  { id: "audit", labelKey: "skills.tab.audit" },
];

async function readData<T>(res: Response, fallback: T): Promise<T> {
  const payload = await readJsonIfOk<{ data?: T }>(res);
  return payload?.data ?? fallback;
}

export function Skills({ apiBase }: SkillsProps): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<TabType>(readTabFromHash);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [editorName, setEditorName] = useState(() => t("skills.editorDefaultName"));
  const [editorVersion, setEditorVersion] = useState("1.0.0");
  const [editorMarkdown, setEditorMarkdown] = useState(() => t("skills.editorDefaultMarkdown"));

  const selectTab = (next: TabType) => {
    setTab(next);
    navigateHash(hashForTab(next));
  };

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadWorkspace = useCallback(async (signal: AbortSignal): Promise<SkillsWorkspace> => {
    const [skillsRes, marketplaceRes, deploymentsRes, auditRes] = await Promise.all([
      fetch(`${apiBase}/api/skills`, { signal }),
      fetch(`${apiBase}/api/skill-marketplace/search?q=${encodeURIComponent(searchQuery)}`, { signal }),
      fetch(`${apiBase}/api/skill-deployments`, { signal }),
      fetch(`${apiBase}/api/skill-audit`, { signal }),
    ]);
    return {
      skills: await readData<SkillItem[]>(skillsRes, []),
      marketplaceItems: await readData<MarketplaceItem[]>(marketplaceRes, []),
      deployments: await readData<DeploymentItem[]>(deploymentsRes, []),
      auditEvents: await readData<AuditEventItem[]>(auditRes, []),
    };
  }, [apiBase, searchQuery]);

  const resource = useDataSurface<SkillsWorkspace>(
    `skills-workspace:${apiBase}:${searchQuery}`,
    [apiBase, searchQuery],
    loadWorkspace,
    { isEmpty: () => false },
  );
  const workspace = resource.state.data ?? EMPTY_WORKSPACE;
  const { skills, marketplaceItems, deployments, auditEvents } = workspace;
  const loading = resource.state.refreshing || resource.state.showSkeleton;

  const handleImportMarketplace = async (refId: string) => {
    try {
      setStatusMessage(t("skills.status.importing", { id: refId }));
      const res = await fetch(`${apiBase}/api/skill-imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "marketplace", ref: refId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: unknown };
        const error = typeof data.error === "string" ? data.error : String(res.status);
        throw new Error(error);
      }
      setStatusMessage(t("skills.status.imported", { id: refId }));
      resource.refresh();
    } catch (e) {
      setStatusMessage(t("skills.status.importFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const handlePublish = async (skillId: string) => {
    try {
      setStatusMessage(t("skills.status.publishing", { id: skillId }));
      const res = await fetch(`${apiBase}/api/skills/${encodeURIComponent(skillId)}/publish`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: unknown };
        const error = typeof data.error === "string" ? data.error : String(res.status);
        throw new Error(error);
      }
      setStatusMessage(t("skills.status.published", { id: skillId }));
      resource.refresh();
    } catch (e) {
      setStatusMessage(t("skills.status.publishFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const handleDeployQuick = async (skillId: string, version: string, agentType: string) => {
    try {
      setStatusMessage(t("skills.status.planning", { id: skillId, agent: agentType }));
      const planRes = await fetch(`${apiBase}/api/skill-deployments/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillVersionId: `${skillId}@${version}`, agentType, scope: "user", nodeId: "local" }),
      });
      const planData = await planRes.json().catch(() => ({})) as { error?: unknown; plan?: { planId?: string } };
      if (!planRes.ok) {
        const error = typeof planData.error === "string" ? planData.error : String(planRes.status);
        throw new Error(error);
      }
      if (!planData?.plan?.planId) {
        throw new Error("No deployment plan id returned");
      }
      const deployRes = await fetch(`${apiBase}/api/skill-deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: planData.plan.planId }),
      });
      if (!deployRes.ok) {
        const data = await deployRes.json().catch(() => ({})) as { error?: unknown };
        const error = typeof data.error === "string" ? data.error : String(deployRes.status);
        throw new Error(error);
      }
      setStatusMessage(t("skills.status.deployed", { id: skillId, agent: agentType }));
      resource.refresh();
    } catch (e) {
      setStatusMessage(t("skills.status.deployFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const saveDraft = async () => {
    try {
      const res = await fetch(`${apiBase}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editorName, markdown: editorMarkdown }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: unknown };
        const error = typeof data.error === "string" ? data.error : String(res.status);
        throw new Error(error);
      }
      setStatusMessage(t("skills.status.saved"));
      resource.refresh();
    } catch (e) {
      setStatusMessage(t("skills.status.saveFailed", { error: String(e) }));
    }
  };

  const agentStatus = (skill: SkillItem, agent: string) => {
    const dep = deployments.find(d => d.agent_id === agent && d.skill_version_id.startsWith(`${skill.id}@`));
    if (!dep) return { label: t("skills.notInstalled"), cls: "empty" };
    if (dep.status === "DEPLOYED") return { label: t("skills.inSync", { version: skill.current_version }), cls: "in-sync" };
    if (dep.status === "FAILED") return { label: t("skills.blocked"), cls: "blocked" };
    return { label: dep.status, cls: "drift" };
  };

  return (
    <div className="skills-workspace">
      <div className="skills-header">
        <div className="skills-title-group">
          <h1>{t("skills.title")}</h1>
          <p className="skills-subtitle">{t("skills.subtitle")}</p>
        </div>
        <div className="skills-header-actions">
          <button type="button" className="skills-tab-btn" onClick={() => resource.refresh()} disabled={loading}>
            {loading ? t("skills.refreshing") : t("skills.refresh")}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div style={{ padding: "8px 14px", background: "rgba(59, 130, 246, 0.15)", border: "1px solid #3b82f6", borderRadius: 6, fontSize: 13, color: "#93c5fd" }}>
          {statusMessage}
        </div>
      )}

      {resource.state.showError && (
        <div style={{ padding: "8px 14px", background: "rgba(239, 68, 68, 0.15)", border: "1px solid #ef4444", borderRadius: 6, fontSize: 13, color: "#fca5a5" }}>
          {t("skills.loadFailed")}
        </div>
      )}

      <div className="skills-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={`skills-tab-btn ${tab === entry.id ? "active" : ""}`}
            onClick={() => selectTab(entry.id)}
          >
            {entry.count ? t(entry.labelKey, { count: skills.length }) : t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="skills-overview-grid">
            <div className="skills-card">
              <span className="skills-card-label">{t("skills.card.registered")}</span>
              <span className="skills-card-val">{skills.length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">{t("skills.card.deployments")}</span>
              <span className="skills-card-val">{deployments.filter(d => d.status === "DEPLOYED").length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">{t("skills.card.marketplace")}</span>
              <span className="skills-card-val">{marketplaceItems.length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">{t("skills.card.audit")}</span>
              <span className="skills-card-val">{auditEvents.length}</span>
            </div>
          </div>

          <div className="skills-card">
            <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.recentActivity")}</h3>
            {auditEvents.length === 0 ? (
              <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>{t("skills.noEvents")}</p>
            ) : (
              <table className="skills-table">
                <thead>
                  <tr>
                    <th>{t("skills.col.timestamp")}</th>
                    <th>{t("skills.col.event")}</th>
                    <th>{t("skills.col.actor")}</th>
                    <th>{t("skills.col.target")}</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEvents.slice(0, 8).map(ev => (
                    <tr key={ev.id}>
                      <td style={{ color: "#94a3b8" }}>{new Date(ev.created_at).toLocaleTimeString()}</td>
                      <td style={{ fontWeight: 600, color: "#60a5fa" }}>{ev.event_type}</td>
                      <td>{ev.actor_type}</td>
                      <td>{ev.skill_id ?? t("skills.system")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: MARKETPLACE */}
      {tab === "marketplace" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              type="text"
              placeholder={t("skills.searchPlaceholder")}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                flexGrow: 1,
                background: "#0f1115",
                border: "1px solid var(--border, #262933)",
                color: "#fff",
                padding: "10px 14px",
                borderRadius: 6,
                fontSize: 14,
              }}
            />
          </div>

          <div className="skills-catalog-grid">
            {marketplaceItems.map(item => (
              <div key={item.id} className="skill-card">
                <div className="skill-card-top">
                  <div>
                    <h4 className="skill-card-title">{item.name}</h4>
                    <span className="skill-card-version">{t("skills.byAuthor", { version: item.version, author: item.author })}</span>
                  </div>
                  {item.verified && (
                    <span style={{ fontSize: 11, background: "rgba(59, 130, 246, 0.2)", color: "#60a5fa", padding: "2px 6px", borderRadius: 4 }}>
                      {t("skills.verified")}
                    </span>
                  )}
                </div>
                <p className="skill-card-desc">{item.description}</p>
                <div className="skill-tags">
                  {item.tags.map(tag => (
                    <span key={tag} className="skill-tag">{tag}</span>
                  ))}
                </div>
                <div className="skill-card-actions">
                  <button
                    className="skills-tab-btn active"
                    style={{ flex: 1 }}
                    onClick={() => void handleImportMarketplace(item.id)}
                  >
                    {t("skills.importToRegistry")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: REGISTRY */}
      {tab === "registry" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {skills.length === 0 ? (
            <div className="skills-card">
              <p style={{ margin: 0, color: "#94a3b8" }}>{t("skills.emptyRegistry")}</p>
            </div>
          ) : (
            <div className="matrix-container">
              <table className="skills-table">
                <thead>
                  <tr>
                    <th>{t("skills.col.skill")}</th>
                    <th>{t("skills.col.version")}</th>
                    <th>{t("skills.col.status")}</th>
                    <th>{t("skills.col.risk")}</th>
                    <th>{t("skills.col.tags")}</th>
                    <th>{t("skills.col.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map(s => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600, color: "#fff" }}>
                        {s.display_name} <br />
                        <span style={{ fontSize: 11, color: "#8b949e", fontWeight: 400 }}>{s.id}</span>
                      </td>
                      <td>v{s.current_version}</td>
                      <td>
                        <span className={`status-pill ${s.status.toLowerCase()}`}>{s.status}</span>
                      </td>
                      <td>
                        <span className={`status-pill ${s.risk_level ?? "low"}`}>{s.risk_level ?? "low"}</span>
                      </td>
                      <td>
                        {s.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="skill-tag" style={{ marginRight: 4 }}>{tag}</span>
                        ))}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {s.status !== "PUBLISHED" && (
                            <button className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => void handlePublish(s.id)}>
                              {t("skills.publish")}
                            </button>
                          )}
                          <button
                            className="skills-tab-btn active"
                            style={{ padding: "4px 8px", fontSize: 11 }}
                            onClick={() => void handleDeployQuick(s.id, s.current_version, "codex")}
                          >
                            {t("skills.deployCodex")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SKILL EDITOR */}
      {tab === "editor" && (
        <div className="skill-editor-container">
          <div className="skill-editor-pane">
            <h3 style={{ margin: 0, fontSize: 16, color: "#fff" }}>{t("skills.editorTitle")}</h3>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="text"
                placeholder={t("skills.editorNamePlaceholder")}
                value={editorName}
                onChange={e => setEditorName(e.target.value)}
                style={{ flex: 1, background: "#0f1115", border: "1px solid var(--border, #262933)", color: "#fff", padding: "6px 10px", borderRadius: 4, fontSize: 13 }}
              />
              <input
                type="text"
                placeholder={t("skills.editorVersionPlaceholder")}
                value={editorVersion}
                onChange={e => setEditorVersion(e.target.value)}
                style={{ width: 80, background: "#0f1115", border: "1px solid var(--border, #262933)", color: "#fff", padding: "6px 10px", borderRadius: 4, fontSize: 13 }}
              />
            </div>
            <textarea
              className="skill-editor-textarea"
              value={editorMarkdown}
              onChange={e => setEditorMarkdown(e.target.value)}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className="skills-tab-btn active"
                onClick={() => void saveDraft()}
              >
                {t("skills.saveDraft")}
              </button>
            </div>
          </div>
          <div className="skill-preview-pane">
            <h3 style={{ margin: 0, fontSize: 16, color: "#fff" }}>{t("skills.previewTitle")}</h3>
            <div className="skill-preview-content">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{editorMarkdown}</pre>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: DEPLOYMENT MATRIX */}
      {tab === "matrix" && (
        <div className="matrix-container">
          <h3 style={{ margin: "0 0 14px 0", fontSize: 16, color: "#fff" }}>{t("skills.matrixTitle")}</h3>
          <table className="skills-matrix-table">
            <thead>
              <tr>
                <th>{t("skills.col.skill")}</th>
                <th>{t("skills.agent.codex")}</th>
                <th>{t("skills.agent.claudeCode")}</th>
                <th>{t("skills.agent.opencode")}</th>
                <th>{t("skills.agent.universal")}</th>
              </tr>
            </thead>
            <tbody>
              {skills.map(s => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600, color: "#fff" }}>{s.display_name}</td>
                  {(["codex", "claude-code", "opencode", "universal"] as const).map(agent => {
                    const st = agentStatus(s, agent);
                    return (
                      <td key={agent}>
                        <span
                          className={`cell-badge ${st.cls}`}
                          onClick={() => void handleDeployQuick(s.id, s.current_version, agent)}
                        >
                          {st.label}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 6: AGENTS */}
      {tab === "agents" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.agentsTitle")}</h3>
          <table className="skills-table">
            <thead>
              <tr>
                <th>{t("skills.col.agent")}</th>
                <th>{t("skills.col.userRoot")}</th>
                <th>{t("skills.col.projectRoot")}</th>
                <th>{t("skills.col.adapterVersion")}</th>
                <th>{t("skills.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.agent.openaiCodex")}</td>
                <td><code>~/.codex/skills/</code></td>
                <td><code>.codex/skills/</code></td>
                <td>1.0.0</td>
                <td><span className="status-pill low">{t("skills.statusReady")}</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.agent.claudeCode")}</td>
                <td><code>~/.claude/skills/</code></td>
                <td><code>.claude/skills/</code></td>
                <td>1.0.0</td>
                <td><span className="status-pill low">{t("skills.statusReady")}</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.agent.opencode")}</td>
                <td><code>~/.config/opencode/skills/</code></td>
                <td><code>.opencode/skills/</code></td>
                <td>1.0.0</td>
                <td><span className="status-pill low">{t("skills.statusReady")}</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.agent.universalAgent")}</td>
                <td><code>~/.agents/skills/</code></td>
                <td><code>.agents/skills/</code></td>
                <td>1.0.0</td>
                <td><span className="status-pill low">{t("skills.statusReady")}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 7: REMOTE NODES */}
      {tab === "nodes" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.nodesTitle")}</h3>
          <p style={{ margin: "0 0 16px 0", color: "#94a3b8", fontSize: 13 }}>
            {t("skills.nodesHelp")}
          </p>
          <table className="skills-table">
            <thead>
              <tr>
                <th>{t("skills.col.node")}</th>
                <th>{t("skills.col.type")}</th>
                <th>{t("skills.col.host")}</th>
                <th>{t("skills.col.environment")}</th>
                <th>{t("skills.col.status")}</th>
                <th>{t("skills.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.localMachine")}</td>
                <td><code>local</code></td>
                <td><code>127.0.0.1</code></td>
                <td><code>dev</code></td>
                <td><span className="status-pill low"><code>ONLINE</code></span></td>
                <td><span style={{ fontSize: 12, color: "#8b949e" }}>{t("skills.self")}</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>{t("skills.vpsMain")}</td>
                <td><code>ssh</code></td>
                <td><code>vps.internal:22</code></td>
                <td><code>staging</code></td>
                <td><span className="status-pill low"><code>CONFIGURED</code></span></td>
                <td>
                  <button type="button" className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }}>
                    {t("skills.testConnection")}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 8: DRIFT */}
      {tab === "drift" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.driftTitle")}</h3>
          <p style={{ margin: "0 0 16px 0", color: "#94a3b8", fontSize: 13 }}>
            {t("skills.driftHelp")}
          </p>
          <table className="skills-table">
            <thead>
              <tr>
                <th>{t("skills.col.deployment")}</th>
                <th>{t("skills.col.targetPath")}</th>
                <th>{t("skills.col.driftState")}</th>
                <th>{t("skills.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map(d => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.skill_version_id}</td>
                  <td>{d.target_path}</td>
                  <td><span className="status-pill low"><code>IN_SYNC</code></span></td>
                  <td>
                    <button type="button" className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }}>
                      {t("skills.checkHash")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 9: REVIEWS */}
      {tab === "reviews" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.reviewsTitle")}</h3>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>{t("skills.reviewsEmpty")}</p>
        </div>
      )}

      {/* TAB 10: AUDIT */}
      {tab === "audit" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>{t("skills.auditTitle")}</h3>
          <table className="skills-table">
            <thead>
              <tr>
                <th>{t("skills.col.timestamp")}</th>
                <th>{t("skills.col.eventType")}</th>
                <th>{t("skills.col.actor")}</th>
                <th>{t("skills.col.targetId")}</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map(ev => (
                <tr key={ev.id}>
                  <td style={{ color: "#94a3b8" }}>{new Date(ev.created_at).toLocaleString()}</td>
                  <td style={{ fontWeight: 600, color: "#60a5fa" }}>{ev.event_type}</td>
                  <td>{ev.actor_type}</td>
                  <td>{ev.skill_id ?? t("skills.system")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

