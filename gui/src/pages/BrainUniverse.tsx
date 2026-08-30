import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n, type TFn } from "../i18n/shared";
import { buildToolCatalog, registerWebMcpTools, type RegisteredTool } from "../webmcp/registry";
import { webMcpAvailability } from "../webmcp/capability";
import { EmptyState } from "../ui";
import { IconRefresh, IconSearch, IconAlert } from "../icons";
import { useDataSurface } from "../data-surface";

/** Shapes mirrored from GET /api/agent-os/* (server is the contract owner). */
interface AgentRow { id: string; name: string; provider: string; type: string; enabled: boolean; health: string }
interface TaskRow { id: string; kind: string; title: string; status: string; attempts: number; error: { message: string } | null }
interface SkillRow { id: string; name: string; version: string; status: string }
interface NodeRow { id: string; name: string; status: string; capabilities: string[] }
interface MemoryRow { id: string; scope: string; title: string; content: string }
interface SearchHit { kind: string; id: string; title: string; snippet: string }
interface ApprovalRow { id: string; capability: string; reason: string; status: string; requestedMs: number }
interface PolicyRow { id: string; subjectType: string; subjectId: string | null; capability: string; effect: string; createdAt: string }
interface ProjectRow { id: string; name: string; rootPath: string; scanEnabled: boolean; scanMode: string }
interface ScanCoverage { filesScanned: number; filesIndexed: number; filesMetadataOnly: number; filesIgnored: number; filesSecretExcluded: number; filesFailed: number; scanDurationMs: number }
interface GraphNode { id: string; type: "universe" | "project" | "folder" | "file"; label: string; path?: string; projectId?: string; disposition?: string; sizeBytes?: number }
interface GraphEdge { source: string; target: string; type: "contains" }
interface AtlasResponse {
  project: { id: string; name: string; rootPath: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { fileCount: number; folderCount: number; totalBytes: number };
}
interface UniverseResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  projects: { id: string; name: string; latestScan: { filesScanned: number } | null }[];
}

interface AuditEventRow {
  id: number;
  tsMs: number;
  tool: string;
  actor: string;
  result: string;
  inputSummary: string;
  riskTier?: string;
}

interface BrainData {
  agents: AgentRow[];
  tasks: TaskRow[];
  skills: SkillRow[];
  skillIssues: { skillId: string; kind: string; detail: string }[];
  nodes: NodeRow[];
  memories: MemoryRow[];
}


function TaskList({ tasks, loading, t }: { tasks: TaskRow[]; loading: boolean; t: (k: "brain.loading" | "brain.empty.tasks" | "brain.col.title" | "brain.col.kind" | "brain.col.status" | "brain.col.attempts") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!loading || tasks.length > 0}>{t("brain.loading")}</p>
      {tasks.length === 0 && !loading ? <EmptyState title={t("brain.empty.tasks")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.col.title")}</th><th>{t("brain.col.kind")}</th><th>{t("brain.col.status")}</th><th>{t("brain.col.attempts")}</th></tr></thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} title={task.error?.message ?? ""}>
                <td>{task.title}</td><td>{task.kind}</td><td><StatusChip status={task.status} /></td><td>{task.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SkillList({ skills, loading, t }: { skills: SkillRow[]; loading: boolean; t: (k: "brain.loading" | "brain.empty.skills" | "brain.col.name" | "brain.col.version" | "brain.col.status") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!loading || skills.length > 0}>{t("brain.loading")}</p>
      {skills.length === 0 && !loading ? <EmptyState title={t("brain.empty.skills")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.col.name")}</th><th>{t("brain.col.version")}</th><th>{t("brain.col.status")}</th></tr></thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.id}><td>{s.name}</td><td>{s.version}</td><td><StatusChip status={s.status} /></td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NodeList({ nodes, loading, t }: { nodes: NodeRow[]; loading: boolean; t: (k: "brain.loading" | "brain.empty.nodes" | "brain.col.name" | "brain.col.status" | "brain.col.capabilities") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!loading || nodes.length > 0}>{t("brain.loading")}</p>
      {nodes.length === 0 && !loading ? <EmptyState title={t("brain.empty.nodes")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.col.name")}</th><th>{t("brain.col.status")}</th><th>{t("brain.col.capabilities")}</th></tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}><td>{n.name}</td><td><StatusChip status={n.status} /></td><td>{n.capabilities.join(", ")}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MemoryList({ memories, loading, t }: { memories: MemoryRow[]; loading: boolean; t: (k: "brain.loading" | "brain.empty.memory") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!loading || memories.length > 0}>{t("brain.loading")}</p>
      {memories.length === 0 && !loading ? <EmptyState title={t("brain.empty.memory")} /> : (
        <ul className="brain-memories">
          {memories.map((m) => (
            <li key={m.id}><strong>{m.title}</strong> <span className="brain-chip brain-chip-warn">{m.scope}</span><p>{m.content}</p></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchResults({ hits, searching, t }: { hits: SearchHit[] | null; searching: boolean; t: (k: "brain.loading" | "brain.empty.search" | "brain.empty.searchResults") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!searching}>{t("brain.loading")}</p>
      {hits === null && !searching ? <EmptyState title={t("brain.empty.search")} /> : hits !== null && hits.length === 0 ? <EmptyState title={t("brain.empty.searchResults")} /> : hits !== null ? (
        <ul className="brain-memories">
          {hits.map((h) => (
            <li key={`${h.kind}:${h.id}`}><strong>{h.title}</strong> <span className="brain-chip brain-chip-ok">{h.kind}</span><p>{h.snippet}</p></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const EMPTY: BrainData = { agents: [], tasks: [], skills: [], skillIssues: [], nodes: [], memories: [] };

type Section = "agents" | "tasks" | "skills" | "nodes" | "memory" | "search" | "policies" | "projects" | "atlas" | "universe" | "tools" | "activity";

function StatusChip({ status }: { status: string }) {
  const tone = status === "online" || status === "succeeded" || status === "running" || status === "active" ? "ok"
    : status === "failed" || status === "offline" ? "bad"
    : "warn";
  return <span className={`brain-chip brain-chip-${tone}`}>{status}</span>;
}

async function getJson<T>(apiBase: string, path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return await res.json() as T;
}

export default function BrainUniverse({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>("agents");
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [lastScan, setLastScan] = useState<{ projectId: string; coverage: ScanCoverage } | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [webMcpStatus, setWebMcpStatus] = useState<{ availability: string; tools: RegisteredTool[] }>(() => ({
    availability: webMcpAvailability(),
    tools: [],
  }));

  const load = useCallback(async (): Promise<BrainData> => {
    const [agents, tasks, skillsRes, nodes, memories, permitsRes, policiesRes, projectsRes] = await Promise.all([
      getJson<{ agents: AgentRow[] }>(apiBase, "/api/agent-os/agents"),
      getJson<{ tasks: TaskRow[] }>(apiBase, "/api/agent-os/tasks"),
      getJson<{ skills: SkillRow[]; issues: { skillId: string; kind: string; detail: string }[] }>(apiBase, "/api/agent-os/skills"),
      getJson<{ nodes: NodeRow[] }>(apiBase, "/api/agent-os/nodes"),
      getJson<{ memories: MemoryRow[] }>(apiBase, "/api/agent-os/memory"),
      getJson<{ approvals: ApprovalRow[] }>(apiBase, "/api/agent-os/permits/pending"),
      getJson<{ policies: PolicyRow[] }>(apiBase, "/api/agent-os/policies"),
      getJson<{ projects: ProjectRow[] }>(apiBase, "/api/agent-os/projects"),
    ]);
    setApprovals(permitsRes.approvals);
    setPolicies(policiesRes.policies);
    setProjects(projectsRes.projects);
    setSelectedProjectId((current) => current ?? projectsRes.projects[0]?.id ?? null);
    return { agents: agents.agents, tasks: tasks.tasks, skills: skillsRes.skills, skillIssues: skillsRes.issues, nodes: nodes.nodes, memories: memories.memories };
  }, [apiBase]);

  const surface = useDataSurface<BrainData>(
    `agent-os-overview:${apiBase}`,
    [apiBase],
    load,
    { isEmpty: (d) => d.agents.length === 0 && d.tasks.length === 0 && d.skills.length === 0 && d.nodes.length === 0 && d.memories.length === 0 },
  );
  const data = surface.state.data ?? EMPTY;

  const auditResource = useDataSurface<{ events: AuditEventRow[] }>(
    `agent-os-audit:${apiBase}`,
    [apiBase],
    useCallback(async () => await getJson<{ events: AuditEventRow[] }>(apiBase, "/api/agent-os/audit?limit=20"), [apiBase]),
    { isEmpty: (body) => body.events.length === 0 },
  );
  const auditEvents = auditResource.state.data?.events ?? [];
  const toolCatalog = useMemo(
    () => buildToolCatalog({ apiBase }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      riskTier: tool.riskTier,
      readOnly: tool.readOnly,
    })),
    [apiBase],
  );

  useEffect(() => {
    let disposed = false;
    void registerWebMcpTools({ apiBase }, {
      hasActiveProject: () => projects.length > 0,
    }).then((result) => {
      if (disposed) return;
      setWebMcpStatus({ availability: result.availability, tools: [] });
    }).catch(() => {
      if (!disposed) setWebMcpStatus({ availability: "unavailable", tools: [] });
    });
    return () => { disposed = true; };
  }, [apiBase, projects.length]);

  const searchLoad = useCallback(async (): Promise<{ hits: SearchHit[] }> => {
    const res = await getJson<{ hits: SearchHit[] }>(apiBase, `/api/agent-os/search?q=${encodeURIComponent(searchQuery)}`);
    return res;
  }, [apiBase, searchQuery]);

  const searchResource = useDataSurface<{ hits: SearchHit[] }>(
    `agent-os-search:${apiBase}:${searchQuery}`,
    [apiBase, searchQuery],
    searchLoad,
    { isEmpty: (r) => r.hits.length === 0, enabled: searchQuery.trim().length > 0 },
  );
  const hits = searchQuery.trim().length > 0 ? searchResource.state.data?.hits : null;

  const atlasLoad = useCallback(async (): Promise<AtlasResponse> => {
    if (!selectedProjectId) throw new Error("project required");
    return await getJson<AtlasResponse>(apiBase, "/api/agent-os/projects/" + selectedProjectId + "/atlas");
  }, [apiBase, selectedProjectId]);
  const atlasResource = useDataSurface<AtlasResponse>(
    `agent-os-atlas:${apiBase}:${selectedProjectId ?? "none"}`,
    [apiBase, selectedProjectId],
    atlasLoad,
    { isEmpty: (atlas) => atlas.nodes.length === 0, enabled: selectedProjectId !== null },
  );

  const universeLoad = useCallback(
    async (): Promise<UniverseResponse> => await getJson<UniverseResponse>(apiBase, "/api/agent-os/universe"),
    [apiBase],
  );
  const universeResource = useDataSurface<UniverseResponse>(
    `agent-os-universe:${apiBase}`,
    [apiBase],
    universeLoad,
    { isEmpty: (universe) => universe.nodes.length === 0 },
  );

  const runSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(query);
  }, [query]);

  const decide = useCallback(async (approvalId: string, decision: "granted" | "denied") => {
    await fetch(`${apiBase}/api/agent-os/permits/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, decision, decidedBy: "dashboard-operator" }),
    });
    setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
  }, [apiBase]);

  const addPolicy = useCallback(async (capability: string, effect: "allow" | "deny") => {
    await fetch(apiBase + "/api/agent-os/policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectType: "global", capability, effect }),
    });
    const res = await getJson<{ policies: PolicyRow[] }>(apiBase, "/api/agent-os/policies");
    setPolicies(res.policies);
  }, [apiBase]);

  const removePolicy = useCallback(async (policyId: string) => {
    await fetch(apiBase + "/api/agent-os/policies/" + policyId, { method: "DELETE" });
    setPolicies((prev) => prev.filter((p) => p.id !== policyId));
  }, [apiBase]);

  const addProject = useCallback(async (name: string, rootPath: string) => {
    await fetch(apiBase + "/api/agent-os/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, rootPath, scanMode: "standard" }),
    });
    const res = await getJson<{ projects: ProjectRow[] }>(apiBase, "/api/agent-os/projects");
    setProjects(res.projects);
  }, [apiBase]);

  const scanNow = useCallback(async (projectId: string) => {
    const res = await fetch(apiBase + "/api/agent-os/projects/" + projectId + "/scan", { method: "POST" });
    if (res.ok) {
      const body = await res.json() as { projectId: string; coverage: ScanCoverage };
      setLastScan(body);
    }
  }, [apiBase]);

  const sections: { id: Section; label: string; count: number }[] = [
    { id: "agents", label: t("brain.tab.agents"), count: data.agents.length },
    { id: "tasks", label: t("brain.tab.tasks"), count: data.tasks.length },
    { id: "skills", label: t("brain.tab.skills"), count: data.skills.length },
    { id: "nodes", label: t("brain.tab.nodes"), count: data.nodes.length },
    { id: "memory", label: t("brain.tab.memory"), count: data.memories.length },
    { id: "search", label: t("brain.tab.search"), count: hits?.length ?? 0 },
    { id: "policies", label: t("brain.tab.policies"), count: policies.length },
    { id: "projects", label: t("brain.tab.projects"), count: projects.length },
    { id: "atlas", label: t("brain.tab.atlas"), count: atlasResource.state.data?.nodes.length ?? 0 },
    { id: "universe", label: t("brain.tab.universe"), count: universeResource.state.data?.projects.length ?? 0 },
    { id: "tools", label: t("brain.tab.tools"), count: toolCatalog.length },
    { id: "activity", label: t("brain.tab.activity"), count: auditEvents.length },
  ];

  return (
    <div className="brain">
      <header className="brain-head">
        <div>
          <h2>{t("brain.title")}</h2>
          <p className="brain-sub">{t("brain.subtitle")}</p>
          <p className={"brain-webmcp-status" + (webMcpStatus.availability === "ready" ? " brain-webmcp-status--ready" : "")}>
            {t("brain.webmcp.label")}: {webMcpStatus.availability === "ready" ? t("brain.webmcp.ready") : t("brain.webmcp.unavailable")}
          </p>
        </div>
        <button className="btn" onClick={() => surface.refresh({ forceLoading: true })} disabled={surface.state.refreshing} title={t("startup.refresh")}>
          <IconRefresh aria-hidden /> {t("startup.refresh")}
        </button>
      </header>

      <form className="brain-ask" onSubmit={runSearch}>
        <IconSearch aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("brain.askPlaceholder")}
          aria-label={t("brain.askPlaceholder")}
        />
        <button className="btn" type="submit" disabled={searchResource.state.refreshing}>{t("brain.search")}</button>
      </form>

      {surface.state.showError && (
        <div className="brain-error" role="alert"><IconAlert aria-hidden /> {t("brain.loadFailed")}</div>
      )}

      {approvals.length > 0 && (
        <section className="brain-approvals" aria-label={t("brain.permits.pending")}>
          <h3>{t("brain.permits.pending")}</h3>
          {approvals.map((a) => (
            <div key={a.id} className="brain-issue">
              <IconAlert aria-hidden />
              <code>{a.capability}</code>
              <span>{a.reason}</span>
              <button type="button" className="btn" onClick={() => void decide(a.id, "granted")}>{t("brain.permits.grant")}</button>
              <button type="button" className="btn" onClick={() => void decide(a.id, "denied")}>{t("brain.permits.deny")}</button>
            </div>
          ))}
        </section>
      )}

      <nav className="brain-tabs" aria-label={t("brain.title")}>
        {sections.map((s) => (
          <button key={s.id} type="button" className={`brain-tab${section === s.id ? " brain-tab--active" : ""}`} onClick={() => setSection(s.id)}>
            {s.label} <span className="brain-count">{s.count}</span>
          </button>
        ))}
      </nav>

      <div className="brain-body">
        {section === "agents" && <AgentList agents={data.agents} loading={surface.state.refreshing} t={t} />}
        {section === "tasks" && <TaskList tasks={data.tasks} loading={surface.state.refreshing} t={t} />}
        {section === "skills" && (
          <div>
            {data.skillIssues.length > 0 && (
              <div className="brain-issues">
                {data.skillIssues.map((i) => (
                  <div key={`${i.skillId}:${i.kind}`} className="brain-issue"><IconAlert aria-hidden /> {i.kind}: {i.detail}</div>
                ))}
              </div>
            )}
            <SkillList skills={data.skills} loading={surface.state.refreshing} t={t} />
          </div>
        )}
        {section === "nodes" && <NodeList nodes={data.nodes} loading={surface.state.refreshing} t={t} />}
        {section === "memory" && <MemoryList memories={data.memories} loading={surface.state.refreshing} t={t} />}
        {section === "search" && <SearchResults hits={hits ?? null} searching={searchResource.state.refreshing} t={t} />}
        {section === "policies" && <PolicyManager policies={policies} onAdd={addPolicy} onRemove={removePolicy} t={t} />}
        {section === "projects" && <ProjectManager projects={projects} lastScan={lastScan} onAdd={addProject} onScan={scanNow} t={t} />}
        {section === "atlas" && (
          <AtlasPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            atlas={atlasResource.state.data}
            loading={atlasResource.state.refreshing}
            t={t}
          />
        )}
        {section === "universe" && (
          <GraphPanel
            graph={universeResource.state.data}
            loading={universeResource.state.refreshing}
            t={t}
          />
        )}
        {section === "tools" && <ToolInspector tools={toolCatalog} t={t} />}
        {section === "activity" && <AgentActivity events={auditEvents} t={t} />}
      </div>
    </div>
  );
}

function AgentList({ agents, loading, t }: { agents: AgentRow[]; loading: boolean; t: (k: "brain.loading" | "brain.empty.agents" | "brain.col.name" | "brain.col.provider" | "brain.col.type" | "brain.col.health") => string }) {
  return (
    <div>
      <p className="brain-loading" hidden={!loading || agents.length > 0}>{t("brain.loading")}</p>
      {agents.length === 0 && !loading ? <EmptyState title={t("brain.empty.agents")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.col.name")}</th><th>{t("brain.col.provider")}</th><th>{t("brain.col.type")}</th><th>{t("brain.col.health")}</th><th>✓</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}><td>{a.name}</td><td>{a.provider}</td><td>{a.type}</td><td><StatusChip status={a.health} /></td><td>{a.enabled ? "✓" : "—"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


function PolicyManager({ policies, onAdd, onRemove, t }: {
  policies: PolicyRow[];
  onAdd: (capability: string, effect: "allow" | "deny") => Promise<void>;
  onRemove: (policyId: string) => Promise<void>;
  t: (k: "brain.policies.capability" | "brain.policies.effect" | "brain.policies.addAllow" | "brain.policies.addDeny" | "brain.policies.empty" | "brain.policies.subject" | "brain.policies.remove") => string;
}) {
  const [capability, setCapability] = useState("fs.read");
  return (
    <div className="brain-policies">
      <div className="brain-policy-add">
        <select value={capability} onChange={(e) => setCapability(e.target.value)} aria-label={t("brain.policies.capability")}>
          {["fs.read", "fs.write", "net.fetch", "shell.exec", "git.push", "deploy"].map((cap) => (
            <option key={cap} value={cap}>{cap}</option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void onAdd(capability, "allow")}>{t("brain.policies.addAllow")}</button>
        <button type="button" className="btn" onClick={() => void onAdd(capability, "deny")}>{t("brain.policies.addDeny")}</button>
      </div>
      {policies.length === 0 ? <EmptyState title={t("brain.policies.empty")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.policies.capability")}</th><th>{t("brain.policies.subject")}</th><th>{t("brain.policies.effect")}</th><th></th></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.id}>
                <td><code>{p.capability}</code></td>
                <td>{p.subjectType}{p.subjectId ? ":" + p.subjectId : ""}</td>
                <td><span className={`brain-chip ${p.effect === "allow" ? "brain-chip-ok" : "brain-chip-bad"}`}>{p.effect}</span></td>
                <td><button type="button" className="btn" onClick={() => void onRemove(p.id)}>{t("brain.policies.remove")}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProjectManager({ projects, lastScan, onAdd, onScan, t }: {
  projects: ProjectRow[];
  lastScan: { projectId: string; coverage: ScanCoverage } | null;
  onAdd: (name: string, rootPath: string) => Promise<void>;
  onScan: (projectId: string) => Promise<void>;
  t: (k: "brain.projects.name" | "brain.projects.path" | "brain.projects.add" | "brain.projects.scan" | "brain.projects.empty" | "brain.projects.files" | "brain.projects.lastScan") => string;
}) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  return (
    <div className="brain-policies">
      <form className="brain-policy-add" onSubmit={(e) => { e.preventDefault(); if (name.trim() && rootPath.trim()) { void onAdd(name, rootPath); setName(""); setRootPath(""); } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("brain.projects.name")} aria-label={t("brain.projects.name")} />
        <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder={t("brain.projects.path")} aria-label={t("brain.projects.path")} />
        <button type="submit" className="btn">{t("brain.projects.add")}</button>
      </form>
      {projects.length === 0 ? <EmptyState title={t("brain.projects.empty")} /> : (
        <table className="brain-table">
          <thead><tr><th>{t("brain.projects.name")}</th><th>{t("brain.projects.path")}</th><th></th></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><code>{p.rootPath}</code></td>
                <td><button type="button" className="btn" onClick={() => void onScan(p.id)}>{t("brain.projects.scan")}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lastScan && (
        <p className="brain-sub">{t("brain.projects.lastScan")}: {lastScan.coverage.filesScanned} {t("brain.projects.files")} · {lastScan.coverage.filesSecretExcluded} / {lastScan.coverage.filesIgnored} / {lastScan.coverage.scanDurationMs}</p>
      )}
    </div>
  );
}

function AtlasPanel({ projects, selectedProjectId, onSelectProject, atlas, loading, t }: {
  projects: ProjectRow[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  atlas: AtlasResponse | undefined;
  loading: boolean;
  t: TFn;
}) {
  return (
    <div className="brain-graph-panel">
      <div className="brain-policy-add">
        <label htmlFor="brain-atlas-project">{t("brain.graph.selectProject")}</label>
        <select
          id="brain-atlas-project"
          value={selectedProjectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </div>
      <GraphPanel graph={atlas} loading={loading} t={t} />
    </div>
  );
}

function GraphPanel({ graph, loading, t }: {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined;
  loading: boolean;
  t: TFn;
}) {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  if (loading && !graph) return <p className="brain-loading">{t("brain.loading")}</p>;
  if (!graph || graph.nodes.length === 0) return <EmptyState title={t("brain.graph.empty")} />;

  const maxNodes = 180;
  const visibleNodes = graph.nodes.slice(0, maxNodes);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const positions = new Map<string, { x: number; y: number }>();
  const typeCounts = new Map<GraphNode["type"], number>();
  const xByType: Record<GraphNode["type"], number> = {
    universe: 40,
    project: 250,
    folder: 460,
    file: 670,
  };
  for (const node of visibleNodes) {
    const index = typeCounts.get(node.type) ?? 0;
    typeCounts.set(node.type, index + 1);
    positions.set(node.id, { x: xByType[node.type], y: 36 + index * 46 });
  }
  const height = Math.max(280, ...[...typeCounts.values()].map((count) => count * 46 + 72));

  return (
    <div className="brain-graph-wrap">
      <div className="brain-graph-summary">
        <span>{visibleNodes.length} {t("brain.graph.nodes")}</span>
        <span>{visibleEdges.length} {t("brain.graph.edges")}</span>
        {graph.nodes.length > maxNodes && <span>{t("brain.graph.capped")}</span>}
      </div>
      <div className="brain-graph-scroll">
        <svg
          className="brain-graph-svg"
          viewBox={`0 0 900 ${height}`}
          role="img"
          aria-label={t("brain.graph.aria")}
        >
          <g className="brain-graph-edges">
            {visibleEdges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              if (!source || !target) return null;
              return (
                <line
                  key={`${edge.source}:${edge.target}`}
                  x1={source.x + 170}
                  y1={source.y + 16}
                  x2={target.x}
                  y2={target.y + 16}
                />
              );
            })}
          </g>
          <g className="brain-graph-nodes">
            {visibleNodes.map((node) => {
              const position = positions.get(node.id)!;
              const label = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
              return (
                <g
                  key={node.id}
                  className={`brain-graph-node brain-graph-node--${node.type}`}
                  data-brain-node-type={node.type}
                  style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedNode(node)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelectedNode(node);
                  }}
                >
                  <rect width="170" height="32" rx="8" />
                  <text x="12" y="21">{label}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {selectedNode && (
        <div className="brain-graph-detail" role="status">
          <strong>{selectedNode.label}</strong>
          <span>{selectedNode.type}</span>
          {selectedNode.path && <code>{selectedNode.path}</code>}
        </div>
      )}
    </div>
  );
}

function ToolInspector({ tools, t }: { tools: Array<{ name: string; description: string; riskTier: string; readOnly: boolean }>; t: TFn }) {
  if (tools.length === 0) return <EmptyState title={t("brain.tool.empty")} />;
  return (
    <table className="brain-table">
      <thead><tr><th>{t("brain.activity.tool")}</th><th>{t("brain.tool.risk")}</th><th>{t("brain.tool.readOnly")}</th><th></th></tr></thead>
      <tbody>
        {tools.map((tool) => (
          <tr key={tool.name}>
            <td><code>{tool.name}</code><p className="brain-sub">{tool.description}</p></td>
            <td><span className={`brain-chip ${tool.riskTier === "R0" || tool.riskTier === "R1" ? "brain-chip-ok" : "brain-chip-bad"}`}>{tool.riskTier}</span></td>
            <td>{tool.readOnly ? t("brain.tool.readOnly") : "—"}</td>
            <td><button type="button" className="btn" disabled title={t("brain.tool.execute")}>{t("brain.tool.execute")}</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AgentActivity({ events, t }: { events: AuditEventRow[]; t: TFn }) {
  if (events.length === 0) return <EmptyState title={t("brain.activity.empty")} />;
  return (
    <table className="brain-table">
      <thead><tr><th>{t("brain.activity.tool")}</th><th>{t("brain.activity.actor")}</th><th>{t("brain.activity.result")}</th><th></th></tr></thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td><code>{event.tool}</code></td>
            <td>{event.actor}</td>
            <td><span className={`brain-chip ${event.result === "success" ? "brain-chip-ok" : "brain-chip-bad"}`}>{event.result}</span></td>
            <td className="brain-sub">{event.inputSummary}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}