import { useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useT, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";

type Tier = "fast" | "standard" | "frontier";
type EffortIntent = "glance" | "measured" | "thorough" | "exhaustive";

export interface RoleProposal {
  role: string;
  model: string | null;
  effort: string | null;
  status: "proposed" | "unassigned" | "unsized";
  tier?: Tier;
  effortIntent?: EffortIntent;
  rationale?: string;
  moveUpIf?: string;
  moveDownIf?: string;
  proposedModel?: string | null;
  proposedEffort?: string | null;
  reason?: string | null;
}

interface Proposals {
  sizingModel: string;
  sizingError: string | null;
  proposals: RoleProposal[];
}

const TIER_LABEL: Record<Tier, TKey> = {
  fast: "integrations.omoRoles.auto.tierFast",
  standard: "integrations.omoRoles.auto.tierStandard",
  frontier: "integrations.omoRoles.auto.tierFrontier",
};

const EFFORT_LABEL: Record<EffortIntent, TKey> = {
  glance: "integrations.omoRoles.auto.effortGlance",
  measured: "integrations.omoRoles.auto.effortMeasured",
  thorough: "integrations.omoRoles.auto.effortThorough",
  exhaustive: "integrations.omoRoles.auto.effortExhaustive",
};

export default function OmoRoleAutoAssign({
  apiBase,
  busy,
  apply,
}: {
  apiBase: string;
  busy: boolean;
  apply: (role: string, model: string, effort: string | null) => Promise<boolean>;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Proposals | null>(null);
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [summary, setSummary] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const response = await fetch(`${apiBase}/api/codex-agent-roles/auto-assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await readJsonOrThrow<Proposals>(response, t("integrations.omoRoles.auto.failed"));
      setResult(payload ?? null);
      setApplied({});
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error && caught.message ? caught.message : t("integrations.omoRoles.auto.failed"));
    } finally {
      setRunning(false);
    }
  };

  const applicable = (result?.proposals ?? []).filter(p => p.status === "proposed" && p.proposedModel && !applied[p.role]);

  const applyOne = async (proposal: RoleProposal): Promise<boolean> => {
    const ok = await apply(proposal.role, proposal.proposedModel!, proposal.proposedEffort ?? null);
    if (ok) setApplied(current => ({ ...current, [proposal.role]: true }));
    return ok;
  };

  const applyAll = async () => {
    setApplying(true);
    let count = 0;
    const total = applicable.length;
    for (const proposal of applicable) if (await applyOne(proposal)) count += 1;
    setSummary(t("integrations.omoRoles.auto.appliedCount", { count: String(count), total: String(total) }));
    setApplying(false);
  };

  const locked = running || applying || busy;

  return (
    <div className="omo-auto-assign">
      <div className="omo-auto-assign-bar">
        <p className="page-sub">{t("integrations.omoRoles.auto.hint")}</p>
        <button type="button" className="btn btn-sm" disabled={locked} onClick={() => void run()}>
          {running ? t("integrations.omoRoles.auto.running") : t("integrations.omoRoles.auto.button")}
        </button>
      </div>
      {error && <Notice tone="err">{error}</Notice>}
      {result && (
        <section className="omo-auto-assign-panel" aria-labelledby="omo-auto-assign-title">
          <div className="omo-auto-assign-bar">
            <h5 id="omo-auto-assign-title">{t("integrations.omoRoles.auto.title")}</h5>
            <span className="integration-meta">{t("integrations.omoRoles.auto.sizedWith", { model: result.sizingModel })}</span>
            <div className="omo-auto-assign-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={locked || applicable.length === 0} onClick={() => void applyAll()}>
                {t("integrations.omoRoles.auto.applyAll")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={applying} onClick={() => { setResult(null); setSummary(null); }}>
                {t("integrations.omoRoles.auto.discard")}
              </button>
            </div>
          </div>
          {result.sizingError && <Notice tone="warn">{t("integrations.omoRoles.auto.sizingFailed", { error: result.sizingError })}</Notice>}
          {summary && <Notice tone="ok">{summary}</Notice>}
          <ul className="omo-auto-assign-list">
            {result.proposals.map(proposal => (
              <li key={proposal.role} aria-label={t("integrations.omoRoles.auto.proposalFor", { role: proposal.role })}>
                <div className="omo-auto-assign-head">
                  <code>{proposal.role}</code>
                  {proposal.tier && proposal.effortIntent && (
                    <span className="integration-meta">
                      {t("integrations.omoRoles.auto.tierEffort", {
                        tier: t(TIER_LABEL[proposal.tier]),
                        effort: t(EFFORT_LABEL[proposal.effortIntent]),
                      })}
                    </span>
                  )}
                </div>
                {proposal.status === "unsized" ? (
                  <p className="integration-meta">{t("integrations.omoRoles.auto.unsized", { reason: proposal.reason ?? "" })}</p>
                ) : (
                  <>
                    <div className="omo-auto-assign-change">
                      <span>{proposal.model ? <code>{proposal.model}</code> : t("integrations.omoRoles.none")}</span>
                      <span aria-hidden="true">→</span>
                      {proposal.proposedModel
                        ? <code>{proposal.proposedModel}{proposal.proposedEffort ? ` · ${proposal.proposedEffort}` : ""}</code>
                        : <span className="integration-meta">{t("integrations.omoRoles.auto.unassigned", { reason: proposal.reason ?? "" })}</span>}
                      {proposal.status === "proposed" && (applied[proposal.role]
                        ? <span className="omo-auto-assign-done">{t("integrations.omoRoles.auto.applied")}</span>
                        : (
                          <button type="button" className="btn btn-sm" disabled={locked} onClick={() => void applyOne(proposal)}>
                            {t("integrations.omoRoles.auto.apply")}
                          </button>
                        ))}
                    </div>
                    {proposal.rationale && <p>{proposal.rationale}</p>}
                    {proposal.moveUpIf && <p className="integration-meta">{t("integrations.omoRoles.auto.moveUp", { text: proposal.moveUpIf })}</p>}
                    {proposal.moveDownIf && <p className="integration-meta">{t("integrations.omoRoles.auto.moveDown", { text: proposal.moveDownIf })}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
