import { channelTier, extendedCombo, isMeteredTier, type SuggestionProvider } from "../../combo-suggestions";
import { parseComboList, validateComboDraft, type ComboItem } from "../../combo-workspace-data";
import { useT } from "../../i18n/shared";
import { freshQuotaReportsFromResponse } from "../../provider-workspace/report";
import { buildQuotaSummary } from "../../quota-summary";
import type { ComboWorkspaceProps } from "../combo-workspace-types";
import { comboDraftErrorText } from "../combo-workspace-utils";
import { ComboSuggestions } from "./ComboSuggestions";
import { useSuggestionExclusions } from "./use-suggestion-exclusions";

type Props = Pick<ComboWorkspaceProps, "combos" | "models" | "providers" | "onSave"> & {
  apiBase: string;
  active: boolean;
  hiddenModels?: string[];
  quotaReports: unknown;
  quotaNow: number;
  lockedComboId: string | null;
};

export function WorkspaceSuggestions(props: Props) {
  const t = useT();
  const exclusions = useSuggestionExclusions(props.apiBase, props.active);
  if (!exclusions.ready) {
    return exclusions.failed ? (
      <div className="rb-suggest" role="alert">
        {t("comboSuggest.exclude.loadFailed")}
        <button type="button" className="btn btn-ghost btn-sm" onClick={exclusions.retry}>{t("common.retry")}</button>
      </div>
    ) : null;
  }

  const saveSuggestion = async (item: ComboItem, isCreate: boolean) => {
    const failure = { ok: false, error: t("comboSuggest.saveChanged") };
    try {
      const [configResponse, exclusionResponse, combosResponse] = await Promise.all([
        fetch(`${props.apiBase}/api/config`),
        fetch(`${props.apiBase}/api/combo-suggestions`),
        isCreate ? undefined : fetch(`${props.apiBase}/api/combos`),
      ]);
      if (!configResponse.ok || !exclusionResponse.ok || (combosResponse && !combosResponse.ok)) return failure;
      const config = await configResponse.json() as {
        providers?: Record<string, Omit<SuggestionProvider, "name">>;
      };
      const { excludedProviders } = await exclusionResponse.json() as { excludedProviders?: unknown };
      if (!Array.isArray(excludedProviders) || excludedProviders.some((name) => typeof name !== "string")) return failure;
      const excluded = new Set(excludedProviders);
      const old = props.combos.find((combo) => combo.id === item.id);
      const live = combosResponse && parseComboList(await combosResponse.json()).find((combo) => combo.id === item.id);
      if (!isCreate && (!old || !live)) return failure;
      const hasTarget = (combo: ComboItem | undefined, provider: string, model: string) =>
        combo?.targets.some((target) => target.provider === provider && target.model === model);
      const liveProviders = new Map(Object.entries(config.providers ?? {}).map(([name, provider]) => [name, { ...provider, name }]));
      const tierOf = (provider: string, model: string) => {
        const current = liveProviders.get(provider);
        return current ? channelTier(current, model) : "metered";
      };
      const proposed = item.targets.filter(({ provider, model }) => isCreate || !hasTarget(old, provider, model));
      const additions = proposed.filter(({ provider, model }) => !live || !hasTarget(live, provider, model))
        .map(({ provider, model }) => ({ provider, model, tier: tierOf(provider, model) }));
      if (!additions.length || additions.some(({ provider, tier }) => {
        const current = liveProviders.get(provider);
        return !current || current.disabled || current.adapter === "jev-decision"
          || excluded.has(provider)
          || (isMeteredTier(tier) && (!live || live.allowMeteredTargets !== true));
      })) return failure;
      return await props.onSave(live ? extendedCombo(live, additions, tierOf) : item, isCreate);
    } catch {
      return failure;
    }
  };
  const providerMap = Object.fromEntries(props.providers.map((provider) => [provider.name, provider]));
  const reports = freshQuotaReportsFromResponse(props.quotaReports, props.quotaNow);
  const quota = new Map(buildQuotaSummary(reports, (provider) => provider)
    .filter((row) => !row.passive)
    .map((row) => [row.provider, row.windows]));
  return (
    <ComboSuggestions
      combos={props.combos}
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
  );
}
