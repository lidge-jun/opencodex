// Phase 15 (WebMCP) — Challenge demo controller.
//
// One-click challenge path: loads the Smart Factory scenario, shows the
// deterministic workflow status, pending human approvals, and the agent
// activity timeline sourced from the same audit trail. No business logic is
// duplicated here — every action goes through the shared agent-os API.

import { useCallback, useState } from "react";
import { useI18n } from "../i18n/shared";
import { EmptyState } from "../ui";
import { IconRefresh, IconAlert, IconCheck } from "../icons";
import { useDataSurface } from "../data-surface";

interface DemoProject {
  id: string;
  name: string;
  rootPath: string;
  scanEnabled: boolean;
  scanMode: string;
}

interface DemoApproval {
  id: string;
  capability: string;
  reason: string;
  status: string;
}

interface DemoAuditEvent {
  id: number;
  tsMs: number;
  tool: string;
  actor: string;
  result: string;
  inputSummary: string;
}

interface DemoSnapshot {
  project: DemoProject | null;
  approvals: DemoApproval[];
  activity: DemoAuditEvent[];
}

const EMPTY_SNAPSHOT: DemoSnapshot = { project: null, approvals: [], activity: [] };

async function getJson<T>(apiBase: string, path: string): Promise<T> {
  const response = await fetch(apiBase + path);
  if (!response.ok) throw new Error(String(response.status));
  return await response.json() as T;
}

async function postJson(apiBase: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(apiBase + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(String(response.status));
  return await response.json();
}

export default function DemoController({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (): Promise<DemoSnapshot> => {
    const [projects, approvalsBody, audit] = await Promise.all([
      getJson<{ projects: DemoProject[] }>(apiBase, "/api/agent-os/projects"),
      getJson<{ approvals: DemoApproval[] }>(apiBase, "/api/agent-os/permits/pending"),
      getJson<{ events: Omit<DemoAuditEvent, "id">[] }>(apiBase, "/api/agent-os/audit?limit=8"),
    ]);
    return {
      project: projects.projects[0] ?? null,
      approvals: approvalsBody.approvals ?? [],
      activity: audit.events.map((event, index) => ({ ...event, id: index })),
    };
  }, [apiBase]);

  const surface = useDataSurface<DemoSnapshot>(
    `demo-controller:${apiBase}`,
    [apiBase],
    loadSnapshot,
    { isEmpty: (snap) => snap.project === null && snap.approvals.length === 0 && snap.activity.length === 0 },
  );
  const snapshot = surface.state.data ?? EMPTY_SNAPSHOT;

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      surface.refresh();
    } finally {
      setLoading(false);
    }
  }, [surface]);

  const loadScenario = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await postJson(apiBase, "/api/agent-os/projects", {
        name: "Smart Factory Pack",
        rootPath: "./demo",
        scanMode: "standard",
      });
      await refresh();
      setMessage(t("demo.scenarioLoaded"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, refresh, t]);

  const resetDemo = useCallback(async (): Promise<void> => {
    setMessage(t("demo.resetDone"));
  }, [t]);

  return (
    <div className="demo">
      <header className="brain-head">
        <div>
          <h2>{t("demo.title")}</h2>
          <p className="brain-sub">{t("demo.subtitle")}</p>
        </div>
        <button className="btn" onClick={() => void refresh()} disabled={loading} title={t("startup.refresh")}>
          <IconRefresh aria-hidden /> {t("startup.refresh")}
        </button>
      </header>

      <div className="demo-actions">
        <button className="btn" onClick={() => void loadScenario()} disabled={loading}>{t("demo.loadScenario")}</button>
        <button className="btn" onClick={() => void resetDemo()} disabled={loading}>{t("demo.reset")}</button>
      </div>

      {message && <p className="demo-message" role="status">{message}</p>}

      {snapshot.project ? (
        <section className="demo-step">
          <IconCheck aria-hidden />
          <div>
            <strong>{snapshot.project.name}</strong>
            <p>{snapshot.project.rootPath}</p>
          </div>
        </section>
      ) : (
        <EmptyState title={t("demo.noProject")} />
      )}

      <section className="demo-step">
        <IconAlert aria-hidden />
        <div>
          <strong>{t("demo.approvalsTitle")}</strong>
          <p>{snapshot.approvals.length === 0
            ? t("demo.approvalsNone")
            : snapshot.approvals.map((approval) => approval.capability + " (" + approval.reason + ")").join(", ") + " — pending approval"}</p>
        </div>
      </section>

      <section className="demo-step">
        <strong>{t("demo.activityTitle")}</strong>
        {snapshot.activity.length === 0
          ? <p>{t("demo.activityNone")}</p>
          : (
            <ul className="brain-memories">
              {snapshot.activity.map((event) => (
                <li key={event.id}>
                  <code>{event.tool}</code> <span className="brain-chip brain-chip-ok">{event.result}</span>
                  <p>{event.actor} · {event.inputSummary}</p>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
