import type { MouseEvent } from "react";
import type { ModelRow } from "../../pages/models-shared";
import { useT } from "../../i18n/shared";
import { IconEyeOff, IconTrash } from "../../icons";

/** Presentation only: ProviderModels owns identity, readiness and all mutations. */
export default function ProviderModelChip({ row, disambiguate, copied, isDefault, selected, action, disabled, onCopy, onRemove }: {
  row: ModelRow;
  disambiguate: boolean;
  copied: boolean;
  isDefault: boolean;
  selected: boolean;
  action: "delete" | "hide" | null;
  disabled: boolean;
  onCopy: () => void;
  onRemove: (button: HTMLButtonElement) => void;
}) {
  const t = useT();
  const label = t(action === "delete" ? "models.customDelete" : "models.hide");
  return (
    <li className="pws-model-chip">
      <button type="button" className="pws-model-chip-main" onClick={onCopy}
        title={row.namespaced} aria-label={copied ? t("pws.modelCopied") : t("pws.copyModelId")}>
        <span className="pws-model-id">{disambiguate ? row.namespaced : row.id}</span>
      </button>
      {isDefault && <span className="badge badge-muted pws-model-flag">{t("prov.defaultBadge")}</span>}
      {selected && <span className="badge badge-accent pws-model-flag">{t("pws.selected")}</span>}
      {action && <button type="button" className="btn btn-ghost btn-sm btn-icon-only"
        onClick={(event: MouseEvent<HTMLButtonElement>) => onRemove(event.currentTarget)}
        disabled={disabled} aria-label={`${label}: ${row.namespaced}`} title={`${label}: ${row.namespaced}`}>
        {action === "delete"
          ? <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
          : <IconEyeOff style={{ width: 13, height: 13 }} aria-hidden="true" />}
      </button>}
    </li>
  );
}
