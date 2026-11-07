import { useId } from "react";
import { useT, type TFn } from "../i18n/shared";
import { Switch } from "../ui";
import {
  shadowSourceModelBadge,
  shadowSourceOptionActive,
  toggleShadowCallSource,
  type ShadowCallSourceOption,
  type ShadowCallSourceRole,
} from "./shadow-call-source";

function roleLabel(t: TFn, role: ShadowCallSourceRole): string {
  switch (role) {
    case "helper": return t("shadowCall.sourceHelper");
    case "memory": return t("shadowCall.sourceMemory");
    case "legacy": return t("shadowCall.sourceLegacy");
    case "custom": return t("shadowCall.sourceCustom");
  }
}

/**
 * One switch per selectable source model. The runtime supplies the options so
 * this component never carries a second copy of the model list.
 */
export function ShadowCallSourceToggles({
  options,
  sourceModels,
  disabled = false,
  saving = false,
  onChange,
  className,
}: {
  options?: ShadowCallSourceOption[];
  sourceModels?: string[];
  disabled?: boolean;
  saving?: boolean;
  onChange: (sourceModels: string[]) => void;
  className?: string;
}) {
  const t = useT();
  const hintId = useId();
  if (!options || options.length === 0) return null;
  return (
    <div
      className={["shadow-source-toggles", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={t("shadowCall.sources")}
      aria-describedby={hintId}
    >
      <div className="shadow-source-toggle-list">
        {options.map(option => {
          const active = shadowSourceOptionActive(option.id, sourceModels);
          const result = toggleShadowCallSource(option, sourceModels);
          const covered = "blocked" in result && result.blocked === "covered" ? result.prefix : undefined;
          const last = "blocked" in result && result.blocked === "last";
          const title = covered
            ? t("shadowCall.sourceCovered", { prefix: covered })
            : last ? t("shadowCall.sourceLastRequired") : undefined;
          const reason = covered
            ? t("shadowCall.sourceCoveredShort", { prefix: covered })
            : last ? t("shadowCall.sourceRequired") : undefined;
          return (
            <span className={`shadow-source-toggle${active ? " on" : ""}`} key={option.id}>
              <Switch
                on={active}
                onClick={() => { if ("sourceModels" in result) onChange(result.sourceModels); }}
                disabled={disabled || saving || covered !== undefined || last}
                label={`${option.id} (${roleLabel(t, option.role)})`}
                title={title}
              />
              <code className="shadow-source-id">{shadowSourceModelBadge([option.id])}</code>
              <span className="muted text-caption shadow-source-role">{roleLabel(t, option.role)}</span>
              {reason ? <span className="muted text-caption shadow-source-reason">{reason}</span> : null}
            </span>
          );
        })}
      </div>
      <span id={hintId} className="muted text-caption shadow-source-hint">{t("shadowCall.sourceHint")}</span>
    </div>
  );
}

