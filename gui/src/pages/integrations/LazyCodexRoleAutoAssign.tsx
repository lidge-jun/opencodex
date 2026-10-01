import { useState } from "react";
import { readJsonOrThrow } from "../../fetch-json";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { EFFORT_LABEL, TIER_LABEL, type SizingEffortIntent, type SizingTier } from "./sizing-labels";

export interface RoleProposal {
  role: string;
  model: string | null;
  effort: string | null;
  status: "proposed" | "unassigned" | "unsized";
  tier?: SizingTier;
  effortIntent?: SizingEffortIntent;
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

function alreadySet(p: RoleProposal): boolean {
  return p.proposedModel === p.model && (p.proposedEffort == null || p.proposedEffort === p.effort);
}

export default function LazyCodexRoleAutoAssign({
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
      const payload = await readJsonOrThrow<Proposals>(response, t("integrations.lazycodexRoles.auto.failed"));
      setResult(payload ?? null);
      setApplied({});
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error && caught.message ? caught.message : t("integrations.lazycodexRoles.auto.failed"));
    } finally {
      setRunning(false);
    }
  };

  const applicable = (result?.proposals ?? []).filter(p =>
    p.status === "proposed" && p.proposedModel && !applied[p.role] && !alreadySet(p));

  const applyOne = async (proposal: RoleProposal): Promise<boolean> => {
    const ok = await apply(proposal.role, proposal.proposedModel!, proposal.proposedEffort ?? null);
    if (ok) setApplied(current => ({ ...current, [proposal.role]: true }));
    return ok;
  };

  const applyAll = async () => {
    setApplying(true);
    let count = 0;
    const total = applicable.length;
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: every PUT rewrites the shared omo.jsonc mirror
    for (const proposal of applicable) if (await applyOne(proposal)) count += 1;
    setSummary(t("integrations.lazycodexRoles.auto.appliedCount", { count: String(count), total: String(total) }));
    setApplying(false);
  };

  const locked = running || applying || busy;

  return (
    <div className="lazycodex-auto-assign">
      <div className="lazycodex-auto-assign-bar">
        <p className="page-sub">{t("integrations.lazycodexRoles.auto.hint")}</p>
        <button type="button" className="btn btn-sm" disabled={locked} onClick={() => void run()}>
          {running ? t("integrations.lazycodexRoles.auto.running") : t("integrations.lazycodexRoles.auto.button")}
        </button>
      </div>
      {error && <Notice tone="err">{error}</Notice>}
      {result && (
        <section className="lazycodex-auto-assign-panel" aria-labelledby="lazycodex-auto-assign-title">
          <div className="lazycodex-auto-assign-bar">
            <h5 id="lazycodex-auto-assign-title">{t("integrations.lazycodexRoles.auto.title")}</h5>
            <span className="integration-meta">{t("integrations.lazycodexRoles.auto.sizedWith", { model: result.sizingModel })}</span>
            <div className="lazycodex-auto-assign-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={locked || applicable.length === 0} onClick={() => void applyAll()}>
                {t("integrations.lazycodexRoles.auto.applyAll")}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={applying} onClick={() => { setResult(null); setSummary(null); }}>
                {t("integrations.lazycodexRoles.auto.discard")}
              </button>
            </div>
          </div>
          {result.sizingError && <Notice tone="warn">{t("integrations.lazycodexRoles.auto.sizingFailed", { error: result.sizingError })}</Notice>}
          {summary && <Notice tone="ok">{summary}</Notice>}
          <ul className="lazycodex-auto-assign-list">
            {result.proposals.map(proposal => (
              <li key={proposal.role} aria-label={t("integrations.lazycodexRoles.auto.proposalFor", { role: proposal.role })}>
                <div className="lazycodex-auto-assign-head">
                  <code>{proposal.role}</code>
                  {proposal.tier && proposal.effortIntent && (
                    <span className="integration-meta">
                      {t("integrations.lazycodexRoles.auto.tierEffort", {
                        tier: t(TIER_LABEL[proposal.tier]),
                        effort: t(EFFORT_LABEL[proposal.effortIntent]),
                      })}
                    </span>
                  )}
                </div>
                {proposal.status === "unsized" ? (
                  <p className="integration-meta">{t("integrations.lazycodexRoles.auto.unsized", { reason: proposal.reason ?? "" })}</p>
                ) : (
                  <>
                    <div className="lazycodex-auto-assign-change">
                      <span>{proposal.model ? <code>{proposal.model}</code> : t("integrations.lazycodexRoles.none")}</span>
                      <span aria-hidden="true">→</span>
                      {proposal.proposedModel
                        ? <code>{proposal.proposedModel}{proposal.proposedEffort ? ` · ${proposal.proposedEffort}` : ""}</code>
                        : <span className="integration-meta">{t("integrations.lazycodexRoles.auto.unassigned", { reason: proposal.reason ?? "" })}</span>}
                      {proposal.status === "proposed" && (applied[proposal.role] || alreadySet(proposal)
                        ? (
                          <span className="lazycodex-auto-assign-done">
                            {applied[proposal.role] ? t("integrations.lazycodexRoles.auto.applied") : t("integrations.lazycodexRoles.auto.alreadySet")}
                          </span>
                        )
                        : (
                          <button type="button" className="btn btn-sm" disabled={locked} onClick={() => void applyOne(proposal)}>
                            {t("integrations.lazycodexRoles.auto.apply")}
                          </button>
                        ))}
                    </div>
                    {proposal.rationale && <p>{proposal.rationale}</p>}
                    {proposal.moveUpIf && <p className="integration-meta">{t("integrations.lazycodexRoles.auto.moveUp", { text: proposal.moveUpIf })}</p>}
                    {proposal.moveDownIf && <p className="integration-meta">{t("integrations.lazycodexRoles.auto.moveDown", { text: proposal.moveDownIf })}</p>}
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
