import { useState } from "react";
import { validateComboDraft, type ComboItem } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { freshQuotaReportsFromResponse } from "../../provider-workspace/report";
import { buildQuotaSummary } from "../../quota-summary";
import type { ComboWorkspaceProps } from "../combo-workspace-types";
import { comboDraftErrorText } from "../combo-workspace-utils";
import { ComboSuggestions } from "./ComboSuggestions";
import { useSuggestionExclusions } from "./use-suggestion-exclusions";

type Props = Pick<ComboWorkspaceProps, "combos" | "models" | "providers"> & {
  apiBase: string;
  onRefresh: () => void;
  active: boolean;
  hiddenModels?: string[];
  quotaReports: unknown;
  quotaNow: number;
  lockedComboId: string | null;
};

export function WorkspaceSuggestions(props: Props) {
  return props.active ? <ActiveWorkspaceSuggestions {...props} /> : null;
}

function ActiveWorkspaceSuggestions(props: Props) {
  const t = useT();
  const exclusions = useSuggestionExclusions(props.apiBase, props.combos);

  const [conflict, setConflict] = useState(false);
  const meteredComboIds = new Set(exclusions.meteredComboIds);
  const combos = props.combos.map((combo) => ({
    ...combo,
    allowMeteredTargets: meteredComboIds.has(combo.id),
  }));

  const saveSuggestion = async (item: ComboItem, isCreate: boolean) => {
    const failure = { ok: false, error: t("cws.saveFailed") };
    if (!exclusions.ready) return failure;
    setConflict(false);
    const previous = props.combos.find((combo) => combo.id === item.id);
    const targets = item.targets.filter(({ provider, model }) => isCreate
      || !previous?.targets.some((target) => target.provider === provider && target.model === model))
      .map(({ provider, model }) => ({ provider, model }));
    try {
      const response = await fetch(`${props.apiBase}/api/combo-suggestions/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, mode: isCreate ? "create" : "append", targets, ...(isCreate ? { allowMeteredTargets: item.allowMeteredTargets } : {}) }),
      });
      if (response.status === 409) {
        setConflict(true);
        exclusions.retry();
        props.onRefresh();
        return { ok: false, error: "" };
      }
      if (!response.ok) return failure;
      props.onRefresh();
      return { ok: true };
    } catch {
      return failure;
    }
  };
  const conflictAlert = conflict && <p className="rb-row-message" role="alert">{t("comboSuggest.saveChanged")}</p>;
  if (!exclusions.available) {
    return <>
      {conflictAlert}
      {exclusions.failed && (
        <div className="rb-suggest" role="alert">
          {t("comboSuggest.exclude.loadFailed")}
          <button type="button" className="btn btn-ghost btn-sm" onClick={exclusions.retry}>{t("common.retry")}</button>
        </div>
      )}
    </>;
  }
  const providerMap = Object.fromEntries(props.providers.map((provider) => [provider.name, provider]));
  const reports = freshQuotaReportsFromResponse(props.quotaReports, props.quotaNow);
  const quota = new Map(buildQuotaSummary(reports, (provider) => provider)
    .filter((row) => !row.passive)
    .map((row) => [row.provider, row.windows]));
  return (
    <>
      {conflictAlert}
      <fieldset className="rb-suggest-policy" disabled={!exclusions.ready}>
        <ComboSuggestions
          combos={combos}
          models={props.models}
          providers={props.providers}
          hiddenModels={new Set(props.hiddenModels)}
          lockedComboId={props.lockedComboId}
          remainingPercent={(provider, model) => {
            const used = (quota.get(provider) ?? []).flatMap((window) => {
              const family = (window.label ?? "").toLowerCase().split(/[\s(]/)[0];
              const matches = window.modelId
                ? window.modelId.toLowerCase() === model.toLowerCase()
                : !family || window.labelKey !== undefined || model.toLowerCase().startsWith(family);
              return matches && window.percent !== undefined ? [window.percent] : [];
            });
            return used.length ? Math.max(0, Math.min(100, 100 - Math.max(...used))) : undefined;
          }}
          validate={(item, isCreate) => {
            const others = props.combos.filter((combo) => isCreate || combo.id !== item.id);
            return validateComboDraft(item, {
              existingIds: others.map((combo) => combo.id),
              existingAliases: others.flatMap((combo) => combo.alias ? [combo.alias] : []),
              combos: others,
              isCreate,
              providers: providerMap,
            });
          }}
          errorText={(code, item) => comboDraftErrorText(t, code, item, providerMap)}
          onCreate={(item) => saveSuggestion(item, true)}
          onExtend={(item) => saveSuggestion(item, false)}
          excludedProviders={exclusions.excluded}
          onExcludedChange={exclusions.save}
        />
      </fieldset>
    </>
  );
}
