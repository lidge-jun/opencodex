import { validateComboDraft } from "../../combo-workspace-data";
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
      onCreate={(item) => props.onSave(item, true)}
      onExtend={(item) => props.onSave(item, false)}
      excludedProviders={exclusions.excluded}
      onExcludedChange={exclusions.ready ? exclusions.save : undefined}
    />
  );
}
