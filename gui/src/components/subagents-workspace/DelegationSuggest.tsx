/**
 * Suggest for the delegation model: the user describes the work Codex hands off, one sizing call
 * returns a tier and an effort, and the server picks the cheapest sufficient model among the
 * options this page offers. The proposal is only shown; Use this goes through the page's own
 * delegation save, the same write the model and effort selects make.
 */
import { useState } from "react";
import { ROLE_INSTRUCTIONS_EXCERPT_CHARS } from "../../../../src/codex/role-sizing-limits";
import { readJsonOrThrow } from "../../fetch-json";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { formatNamespacedModelId } from "../../provider-icons";
import type { RoleProposal } from "../../pages/integrations/LazyCodexRoleAutoAssign";
import { EFFORT_LABEL, TIER_LABEL } from "../../pages/integrations/sizing-labels";
import type { DelegationModelOption, DelegationPatch } from "../../pages/use-subagent-delegation";

interface Suggestion {
  sizingModel: string;
  sizingError: string | null;
  proposal: Omit<RoleProposal, "role">;
}

export default function DelegationSuggest({
  apiBase,
  model,
  effort,
  available,
  saving,
  onAccept,
}: {
  apiBase: string;
  model: string;
  effort: string;
  available: DelegationModelOption[];
  saving: boolean;
  onAccept: (patch: DelegationPatch) => void;
}) {
  const t = useT();
  const [work, setWork] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Suggestion | null>(null);

  const label = (slug: string) => {
    const option = available.find(o => o.namespaced === slug);
    return option ? formatNamespacedModelId(`${option.provider}/${option.model}`, t) : slug;
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/injection-model/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work: work.trim() }),
      });
      setResult(await readJsonOrThrow<Suggestion>(response, t("sub.suggest.failed")) ?? null);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error && caught.message ? caught.message : t("sub.suggest.failed"));
    } finally {
      setRunning(false);
    }
  };

  const p = result?.proposal;
  const alreadySet = !!p?.proposedModel && p.proposedModel === model && (p.proposedEffort ?? "") === effort;
  const announcement = running ? t("sub.suggest.running") : result ? t("sub.suggest.title") : "";

  return (
    <div className="swi-suggest">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <label className="swi-suggest-label" htmlFor="swi-suggest-work">{t("sub.suggest.label")}</label>
      <div className="swi-suggest-input">
        <textarea
          id="swi-suggest-work"
          className="input"
          rows={2}
          maxLength={ROLE_INSTRUCTIONS_EXCERPT_CHARS}
          value={work}
          placeholder={t("sub.suggest.placeholder")}
          onChange={e => setWork(e.target.value)}
          disabled={running}
        />
        <button type="button" className="btn btn-sm" disabled={running || saving || work.trim() === ""} onClick={() => void run()}>
          {running ? t("sub.suggest.running") : t("sub.suggest.submit")}
        </button>
      </div>
      {error && <Notice tone="err">{error}</Notice>}
      {result && p && (
        <section className="swi-suggest-result" aria-label={t("sub.suggest.title")}>
          <div className="swi-suggest-head">
            {p.tier && p.effortIntent && (
              <span className="font-semibold">
                {t("integrations.lazycodexRoles.auto.tierEffort", { tier: t(TIER_LABEL[p.tier]), effort: t(EFFORT_LABEL[p.effortIntent]) })}
              </span>
            )}
            <span className="muted setting-hint">{t("integrations.lazycodexRoles.auto.sizedWith", { model: result.sizingModel })}</span>
          </div>
          {result.sizingError && <Notice tone="warn">{t("integrations.lazycodexRoles.auto.sizingFailed", { error: result.sizingError })}</Notice>}
          {p.status === "unsized" ? (
            <p className="muted setting-hint">{t("integrations.lazycodexRoles.auto.unsized", { reason: p.reason ?? "" })}</p>
          ) : (
            <>
              <div className="swi-suggest-change">
                <span>{p.model ? label(p.model) : t("dash.injectionNone")}{p.effort ? ` · ${p.effort}` : ""}</span>
                <span aria-hidden="true">→</span>
                {p.proposedModel
                  ? <strong>{label(p.proposedModel)}{p.proposedEffort ? ` · ${p.proposedEffort}` : ""}</strong>
                  : <span className="muted">{t("integrations.lazycodexRoles.auto.unassigned", { reason: p.reason ?? "" })}</span>}
              </div>
              {p.rationale && <p>{p.rationale}</p>}
              {p.moveUpIf && <p className="muted setting-hint">{t("integrations.lazycodexRoles.auto.moveUp", { text: p.moveUpIf })}</p>}
              {p.moveDownIf && <p className="muted setting-hint">{t("integrations.lazycodexRoles.auto.moveDown", { text: p.moveDownIf })}</p>}
            </>
          )}
          <div className="swi-suggest-actions">
            {alreadySet
              ? <span className="swi-suggest-done">{t("integrations.lazycodexRoles.auto.alreadySet")}</span>
              : p.status === "proposed" && p.proposedModel && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={saving}
                  onClick={() => onAccept({ model: p.proposedModel!, effort: p.proposedEffort ?? null })}
                >
                  {t("sub.suggest.accept")}
                </button>
              )}
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setResult(null)}>
              {t("integrations.lazycodexRoles.auto.discard")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
