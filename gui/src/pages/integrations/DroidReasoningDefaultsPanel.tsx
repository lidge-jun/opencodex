import { useT } from "../../i18n/shared";
import { Select } from "../../ui";
import type { DroidReasoningStatus } from "./integration-api";

export default function DroidReasoningDefaultsPanel({
  reasoning,
  defaults,
  disabled,
  onChange,
  onReview,
}: {
  reasoning: DroidReasoningStatus;
  defaults: Record<string, string>;
  disabled: boolean;
  onChange: (next: Record<string, string>) => void;
  onReview: () => void;
}) {
  const t = useT();
  const effortsByModel = new Map(reasoning.models.map(model => [model.model, new Set(model.efforts)]));
  const unsupported = Object.entries(defaults).filter(([modelId, effort]) => {
    return !effortsByModel.get(modelId)?.has(effort);
  });

  const setDefault = (model: string, effort: string) => {
    const next = { ...defaults };
    if (effort) next[model] = effort;
    else delete next[model];
    onChange(next);
  };

  return (
    <section className="droid-reasoning-panel" aria-labelledby="droid-reasoning-title">
      <div className="droid-reasoning-heading">
        <div>
          <h4 id="droid-reasoning-title">{t("integrations.droidReasoning.title")}</h4>
          <p className="page-sub">{t("integrations.droidReasoning.description")}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onReview} disabled={disabled}>
          {t("integrations.droidReasoning.saveReview")}
        </button>
      </div>

      {reasoning.models.length > 0 ? (
        <ul className="droid-reasoning-list">
          {reasoning.models.map(model => {
            const selected = defaults[model.model] ?? "";
            const declared = model.efforts.includes(selected);
            const options = [
              { value: "", label: t("integrations.droidReasoning.noDefault") },
              ...(!declared && selected ? [{
                value: selected,
                label: t("integrations.droidReasoning.unsupportedEffort", { effort: selected }),
              }] : []),
              ...model.efforts.map(effort => ({ value: effort, label: effort })),
            ];
            return (
              <li className="droid-reasoning-row" key={model.model}>
                <div className="droid-reasoning-model">
                  <span>{model.label}</span>
                  <code>{model.model}</code>
                </div>
                {model.efforts.length > 0 ? (
                  <Select
                    value={selected}
                    options={options}
                    onChange={effort => setDefault(model.model, effort)}
                    disabled={disabled}
                    label={t("integrations.droidReasoning.modelDefault", { model: model.label })}
                  />
                ) : (
                  <span className="muted text-caption">{t("integrations.droidReasoning.noEfforts")}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="page-sub">{t("integrations.droidReasoning.noModels")}</p>
      )}

      {unsupported.length > 0 && (
        <div className="droid-reasoning-unsupported" role="status">
          <p>{t("integrations.droidReasoning.unsupportedTitle")}</p>
          <ul>
            {unsupported.map(([model, effort]) => (
              <li key={model}>
                <code>{model}</code>
                {" "}{t("integrations.droidReasoning.unsupportedEffort", { effort })}
                <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={() => setDefault(model, "")}>
                  {t("integrations.droidReasoning.clear")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
