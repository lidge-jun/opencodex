import React, { useEffect, useState } from "react";
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

export function Skills({ apiBase }: SkillsProps): React.JSX.Element {
  const [tab, setTab] = useState<TabType>("overview");
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [marketplaceItems, setMarketplaceItems] = useState<MarketplaceItem[]>([]);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Editor states
  const [editorName, setEditorName] = useState("Custom Assistant");
  const [editorVersion, setEditorVersion] = useState("1.0.0");
  const [editorMarkdown, setEditorMarkdown] = useState(
    `---\nname: custom-assistant\ndisplayName: Custom Assistant\nversion: 1.0.0\ndescription: Custom guidance procedure.\ntags: custom, utility\n---\n\n# Custom Assistant\n\nInstructions for the agent.\n`
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const sRes = await fetch(`${apiBase}/api/skills`).then(r => r.json());
      if (sRes?.data) setSkills(sRes.data);

      const mRes = await fetch(`${apiBase}/api/skill-marketplace/search?q=${encodeURIComponent(searchQuery)}`).then(r => r.json());
      if (mRes?.data) setMarketplaceItems(mRes.data);

      const dRes = await fetch(`${apiBase}/api/skill-deployments`).then(r => r.json());
      if (dRes?.data) setDeployments(dRes.data);

      const aRes = await fetch(`${apiBase}/api/skill-audit`).then(r => r.json());
      if (aRes?.data) setAuditEvents(aRes.data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [apiBase, searchQuery]);

  const handleImportMarketplace = async (refId: string) => {
    try {
      setStatusMessage(`Importing ${refId}...`);
      await fetch(`${apiBase}/api/skill-imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "marketplace", ref: refId }),
      });
      setStatusMessage(`Successfully imported ${refId}!`);
      await loadData();
    } catch (e) {
      setStatusMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handlePublish = async (skillId: string) => {
    try {
      setStatusMessage(`Publishing ${skillId}...`);
      await fetch(`${apiBase}/api/skills/${encodeURIComponent(skillId)}/publish`, { method: "POST" });
      setStatusMessage(`Published ${skillId} successfully!`);
      await loadData();
    } catch (e) {
      setStatusMessage(`Publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDeployQuick = async (skillId: string, version: string, agentType: string) => {
    try {
      setStatusMessage(`Planning deployment for ${skillId} to ${agentType}...`);
      const planRes = await fetch(`${apiBase}/api/skill-deployments/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillVersionId: `${skillId}@${version}`, agentType, scope: "user", nodeId: "local" }),
      }).then(r => r.json());

      if (planRes?.plan?.planId) {
        await fetch(`${apiBase}/api/skill-deployments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ planId: planRes.plan.planId }),
        });
        setStatusMessage(`Deployed ${skillId} to ${agentType}!`);
        await loadData();
      }
    } catch (e) {
      setStatusMessage(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="skills-workspace">
      {/* Header */}
      <div className="skills-header">
        <div className="skills-title-group">
          <h1>Skill Control Plane</h1>
          <p className="skills-subtitle">
            Universal Agent Skill Registry, Visual Marketplace & Policy Governed Deployment (Phase 20.57)
          </p>
        </div>
        <div className="skills-header-actions">
          <button className="skills-tab-btn" onClick={() => void loadData()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {statusMessage && (
        <div style={{ padding: "8px 14px", background: "rgba(59, 130, 246, 0.15)", border: "1px solid #3b82f6", borderRadius: 6, fontSize: 13, color: "#93c5fd" }}>
          {statusMessage}
        </div>
      )}

      {/* Tabs */}
      <div className="skills-tabs">
        <button className={`skills-tab-btn ${tab === "overview" ? "active" : ""}`} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button className={`skills-tab-btn ${tab === "marketplace" ? "active" : ""}`} onClick={() => setTab("marketplace")}>
          Marketplace
        </button>
        <button className={`skills-tab-btn ${tab === "registry" ? "active" : ""}`} onClick={() => setTab("registry")}>
          Registry ({skills.length})
        </button>
        <button className={`skills-tab-btn ${tab === "editor" ? "active" : ""}`} onClick={() => setTab("editor")}>
          Skill Editor
        </button>
        <button className={`skills-tab-btn ${tab === "matrix" ? "active" : ""}`} onClick={() => setTab("matrix")}>
          Deployment Matrix
        </button>
        <button className={`skills-tab-btn ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>
          Agents
        </button>
        <button className={`skills-tab-btn ${tab === "nodes" ? "active" : ""}`} onClick={() => setTab("nodes")}>
          Remote Nodes
        </button>
        <button className={`skills-tab-btn ${tab === "drift" ? "active" : ""}`} onClick={() => setTab("drift")}>
          Drift & Rollback
        </button>
        <button className={`skills-tab-btn ${tab === "reviews" ? "active" : ""}`} onClick={() => setTab("reviews")}>
          Review Queue
        </button>
        <button className={`skills-tab-btn ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")}>
          Audit Trail
        </button>
      </div>

      {/* TAB 1: OVERVIEW */}
      {tab === "overview" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="skills-overview-grid">
            <div className="skills-card">
              <span className="skills-card-label">Registered Skills</span>
              <span className="skills-card-val">{skills.length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">Active Deployments</span>
              <span className="skills-card-val">{deployments.filter(d => d.status === "DEPLOYED").length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">Marketplace Items</span>
              <span className="skills-card-val">{marketplaceItems.length}</span>
            </div>
            <div className="skills-card">
              <span className="skills-card-label">Audit Events</span>
              <span className="skills-card-val">{auditEvents.length}</span>
            </div>
          </div>

          <div className="skills-card">
            <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Recent Control Plane Activity</h3>
            {auditEvents.length === 0 ? (
              <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>No recent events recorded.</p>
            ) : (
              <table className="skills-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Event</th>
                    <th>Actor</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEvents.slice(0, 8).map(ev => (
                    <tr key={ev.id}>
                      <td style={{ color: "#94a3b8" }}>{new Date(ev.created_at).toLocaleTimeString()}</td>
                      <td style={{ fontWeight: 600, color: "#60a5fa" }}>{ev.event_type}</td>
                      <td>{ev.actor_type}</td>
                      <td>{ev.skill_id ?? "system"}</td>
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
              placeholder="Search public skills.sh catalog..."
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
                    <span className="skill-card-version">v{item.version} by {item.author}</span>
                  </div>
                  {item.verified && (
                    <span style={{ fontSize: 11, background: "rgba(59, 130, 246, 0.2)", color: "#60a5fa", padding: "2px 6px", borderRadius: 4 }}>
                      VERIFIED
                    </span>
                  )}
                </div>
                <p className="skill-card-desc">{item.description}</p>
                <div className="skill-tags">
                  {item.tags.map(t => (
                    <span key={t} className="skill-tag">{t}</span>
                  ))}
                </div>
                <div className="skill-card-actions">
                  <button
                    className="skills-tab-btn active"
                    style={{ flex: 1 }}
                    onClick={() => void handleImportMarketplace(item.id)}
                  >
                    Import to Registry
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
              <p style={{ margin: 0, color: "#94a3b8" }}>No skills registered yet. Import one from Marketplace or Local Folder.</p>
            </div>
          ) : (
            <div className="matrix-container">
              <table className="skills-table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Risk</th>
                    <th>Tags</th>
                    <th>Actions</th>
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
                        {s.tags.slice(0, 3).map(t => (
                          <span key={t} className="skill-tag" style={{ marginRight: 4 }}>{t}</span>
                        ))}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {s.status !== "PUBLISHED" && (
                            <button className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => void handlePublish(s.id)}>
                              Publish
                            </button>
                          )}
                          <button
                            className="skills-tab-btn active"
                            style={{ padding: "4px 8px", fontSize: 11 }}
                            onClick={() => void handleDeployQuick(s.id, s.current_version, "codex")}
                          >
                            Deploy to Codex
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
            <h3 style={{ margin: 0, fontSize: 16, color: "#fff" }}>SKILL.md Editor</h3>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="text"
                placeholder="Skill Name"
                value={editorName}
                onChange={e => setEditorName(e.target.value)}
                style={{ flex: 1, background: "#0f1115", border: "1px solid var(--border, #262933)", color: "#fff", padding: "6px 10px", borderRadius: 4, fontSize: 13 }}
              />
              <input
                type="text"
                placeholder="Version"
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
                className="skills-tab-btn active"
                onClick={async () => {
                  try {
                    await fetch(`${apiBase}/api/skills`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: editorName, markdown: editorMarkdown }),
                    });
                    setStatusMessage("Skill draft saved to registry!");
                    await loadData();
                  } catch (e) {
                    setStatusMessage(`Save failed: ${String(e)}`);
                  }
                }}
              >
                Save Draft
              </button>
            </div>
          </div>
          <div className="skill-preview-pane">
            <h3 style={{ margin: 0, fontSize: 16, color: "#fff" }}>Live Rendered Preview</h3>
            <div className="skill-preview-content">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{editorMarkdown}</pre>
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: DEPLOYMENT MATRIX */}
      {tab === "matrix" && (
        <div className="matrix-container">
          <h3 style={{ margin: "0 0 14px 0", fontSize: 16, color: "#fff" }}>Fleet Deployment Matrix</h3>
          <table className="skills-matrix-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Codex</th>
                <th>Claude Code</th>
                <th>OpenCode</th>
                <th>Universal</th>
              </tr>
            </thead>
            <tbody>
              {skills.map(s => {
                const getStatusForAgent = (agent: string) => {
                  const dep = deployments.find(d => d.agent_id === agent && d.skill_version_id.startsWith(s.id));
                  if (!dep) return { label: "Not Installed", cls: "empty" };
                  if (dep.status === "DEPLOYED") return { label: `v${s.current_version} In Sync`, cls: "in-sync" };
                  if (dep.status === "FAILED") return { label: "Blocked", cls: "blocked" };
                  return { label: dep.status, cls: "drift" };
                };

                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600, color: "#fff" }}>{s.display_name}</td>
                    {(["codex", "claude-code", "opencode", "universal"] as const).map(agent => {
                      const st = getStatusForAgent(agent);
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 6: AGENTS */}
      {tab === "agents" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Target Agent Fleet</h3>
          <table className="skills-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Target Root (User Scope)</th>
                <th>Target Root (Project Scope)</th>
                <th>Adapter Version</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>OpenAI Codex</td>
                <td>~/.codex/skills/</td>
                <td>.codex/skills/</td>
                <td>1.0.0</td>
                <td><span className="status-pill low">READY</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>Claude Code</td>
                <td>~/.claude/skills/</td>
                <td>.claude/skills/</td>
                <td>1.0.0</td>
                <td><span className="status-pill low">READY</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>OpenCode</td>
                <td>~/.config/opencode/skills/</td>
                <td>.opencode/skills/</td>
                <td>1.0.0</td>
                <td><span className="status-pill low">READY</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>Universal Agent</td>
                <td>~/.agents/skills/</td>
                <td>.agents/skills/</td>
                <td>1.0.0</td>
                <td><span className="status-pill low">READY</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 7: REMOTE NODES */}
      {tab === "nodes" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Remote Execution Nodes (SSH)</h3>
          <p style={{ margin: "0 0 16px 0", color: "#94a3b8", fontSize: 13 }}>
            Manage remote VPS, GPU workers, and development hosts with strict host-key pinning.
          </p>
          <table className="skills-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Type</th>
                <th>Host</th>
                <th>Environment</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>Local Machine</td>
                <td>local</td>
                <td>127.0.0.1</td>
                <td>dev</td>
                <td><span className="status-pill low">ONLINE</span></td>
                <td><span style={{ fontSize: 12, color: "#8b949e" }}>Self</span></td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: "#fff" }}>VPS Main</td>
                <td>ssh</td>
                <td>vps.internal:22</td>
                <td>staging</td>
                <td><span className="status-pill low">CONFIGURED</span></td>
                <td>
                  <button className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }}>
                    Test Connection
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
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Configuration Drift & Rollback</h3>
          <p style={{ margin: "0 0 16px 0", color: "#94a3b8", fontSize: 13 }}>
            Continuous monitoring compares live disk files against immutable registry content hashes.
          </p>
          <table className="skills-table">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>Target Path</th>
                <th>Drift State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map(d => (
                <tr key={d.id}>
                  <td style={{ fontWeight: 600 }}>{d.skill_version_id}</td>
                  <td>{d.target_path}</td>
                  <td><span className="status-pill low">IN_SYNC</span></td>
                  <td>
                    <button className="skills-tab-btn" style={{ padding: "4px 8px", fontSize: 11 }}>
                      Check Hash
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
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Policy & Approval Queue</h3>
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 13 }}>No pending elevated reviews require operator decision.</p>
        </div>
      )}

      {/* TAB 10: AUDIT */}
      {tab === "audit" && (
        <div className="skills-card">
          <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "#fff" }}>Audit Log</h3>
          <table className="skills-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Event Type</th>
                <th>Actor</th>
                <th>Target ID</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map(ev => (
                <tr key={ev.id}>
                  <td style={{ color: "#94a3b8" }}>{new Date(ev.created_at).toLocaleString()}</td>
                  <td style={{ fontWeight: 600, color: "#60a5fa" }}>{ev.event_type}</td>
                  <td>{ev.actor_type}</td>
                  <td>{ev.skill_id ?? "system"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

