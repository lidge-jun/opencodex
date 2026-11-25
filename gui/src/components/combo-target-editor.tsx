import type { ComboStrategy, ComboTarget, ProviderQuotaStates } from "../combo-workspace-data";
import { COMBO_EFFORTS, newComboTarget } from "../combo-workspace-data";
import { IconArrowDown, IconArrowUp, IconGrip, IconPlus, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Select, Switch } from "../ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { clampedNumberInput, comboTargetProviderName, enabledProviders, modelsForProvider } from "./combo-workspace-utils";

import { useComboTargetReorder } from "./combo-target-reorder";

export function TargetEditor({
  targets,
  strategy,
  providers,
  models,
  capabilityModels = models,
  providerQuotaStates,
  inDialog,
  requiresAutomaticConsent,
  disabled,
  onChange,
}: {
  targets: ComboTarget[];
  strategy: ComboStrategy;
  providers: ProviderOption[];
  models: ModelOption[];
  capabilityModels?: ModelOption[];
  providerQuotaStates: ProviderQuotaStates;
  inDialog?: boolean;
  requiresAutomaticConsent?: (target: ComboTarget) => boolean;
  disabled?: boolean;
  onChange: (next: ComboTarget[]) => void;
}) {
  const t = useT();
  const provs = enabledProviders(providers);
  const failOpenIndex = strategy === "jev"
    ? targets.findIndex((target) => {
        const provider = providers.find(candidate => candidate.name === target.provider.trim());
        return !!target.provider.trim()
          && !!target.model.trim()
          && provider !== undefined
          && provider.disabled !== true
          && provider.adapter !== "jev-decision"
          && providerQuotaStates[target.provider.trim()] !== "exhausted";
      })
    : -1;

  const update = (index: number, patch: Partial<ComboTarget>) => {
    onChange(targets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const replaceModel = (index: number, patch: Pick<ComboTarget, "provider" | "model">) => {
    onChange(targets.map((row, i) => {
      if (i !== index) return row;
      const { reasoningEfforts: _reasoningEfforts, modelProfile: _modelProfile, ...rest } = row;
      return { ...rest, ...patch };
    }));
  };

  const { listRef, reorder, grip } = useComboTargetReorder(targets, onChange);

  return (
    <>
      <ol className="cwi-target-list" role="list" ref={listRef}>
        {targets.map((row, index) => {
          const currentProvider = providers.find((provider) => provider.name === row.provider);
          const providerOptions = currentProvider && !provs.some((provider) => provider.name === row.provider)
            ? [...provs, currentProvider]
            : provs;
          const modelIds = modelsForProvider(models, row.provider, providers);
          const options = row.model && !modelIds.includes(row.model)
            ? [row.model, ...modelIds]
            : modelIds;
          const modelSelectDisabled = !row.provider;
          const quotaState = providerQuotaStates[row.provider.trim()] ?? "unknown";
          const knownPaid = requiresAutomaticConsent?.(row) === true;
          const advertisedReasoningEfforts = strategy === "jev" ? capabilityModels.find(
            model => model.provider === row.provider && model.id === row.model,
          )?.reasoningEfforts : undefined;
          const advertisedEffortSet = advertisedReasoningEfforts && new Set(advertisedReasoningEfforts);
          const selectableReasoningEfforts = advertisedEffortSet && COMBO_EFFORTS.filter(effort => advertisedEffortSet.has(effort));
          const allowedEffortSet = row.reasoningEfforts && new Set(row.reasoningEfforts);
          const selectedReasoningEfforts = selectableReasoningEfforts?.filter(effort => allowedEffortSet?.has(effort) ?? true) ?? [];
          const selectedEffortSet = new Set(selectedReasoningEfforts);
          return (
            <li key={row.clientKey ?? `${row.provider}:${row.model}`} className="cwi-target-entry">
              <div className="cwi-target-row">
                <button
                  type="button"
                  className="cwi-target-grip"
                  disabled={disabled || targets.length < 2}
                  tabIndex={-1}
                  aria-label={t("cws.target.drag")}
                  title={t("cws.target.drag")}
                  {...grip(index)}
                >
                  <IconGrip width={16} height={16} aria-hidden="true" />
                </button>
                <div className="cwi-target-pickers">
                  <Select
                    fullWidth
                    portal={inDialog ? false : undefined}
                    value={row.provider}
                    disabled={disabled}
                    label={t("cws.target.provider")}
                    onChange={(provider) => {
                      const first = modelsForProvider(models, provider, providers)[0] ?? "";
                      replaceModel(index, { provider, model: first });
                    }}
                    options={[
                      { value: "", label: t("cws.target.pickProvider") },
                      ...providerOptions.map((provider) => {
                        const name = comboTargetProviderName(provider.name, provider, t);
                        return { value: provider.name, label: provider.disabled ? t("cws.target.disabled", { name }) : name };
                      }),
                    ]}
                  />
                  <Select
                    fullWidth
                    portal={inDialog ? false : undefined}
                    value={row.model}
                    disabled={disabled || modelSelectDisabled}
                    label={t("cws.target.model")}
                    onChange={(model) => replaceModel(index, { provider: row.provider, model })}
                    options={[
                      {
                        value: "",
                        label: modelSelectDisabled
                          ? t("cws.target.pickProviderFirst")
                          : options.length === 0
                            ? t("cws.target.noModels")
                            : t("cws.target.pickModel"),
                      },
                      ...options.map((id) => ({ value: id, label: id })),
                    ]}
                  />
                </div>
                {(strategy === "round-robin" || strategy === "random") && (
                  <input
                    className="input mono"
                    type="number"
                    min={1}
                    max={10000}
                    value={row.weight ?? 1}
                    disabled={disabled}
                    aria-label={t("cws.target.weight")}
                    onChange={(e) => {
                      const weight = clampedNumberInput(e.target.value, 1, 10000);
                      if (weight === undefined) return;
                      update(index, { weight });
                    }}
                  />
                )}
                <div className="cwi-target-tools">
                  <div className="cwi-target-billing">
                    {knownPaid
                      ? <span className="cwi-billing-label" data-paid>{t("cws.preview.paid")}</span>
                      : <Switch showLabel label={t("cws.meteredTarget")} on={row.metered === true}
                          disabled={disabled} onClick={() => update(index, { metered: !row.metered })} />}
                    {quotaState !== "unknown" && (
                      <span className={`cwi-quota-badge cwi-quota-badge--${quotaState}`}>
                        {t(`cws.quota.${quotaState}`)}
                      </span>
                    )}
                  </div>
                  <div className="cwi-target-reorder">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={disabled || index === 0}
                      aria-label={t("cws.target.moveUp")}
                      data-cwi-move="up"
                      onClick={() => reorder(index, index - 1, "up")}
                    >
                      <IconArrowUp width={14} height={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={disabled || index === targets.length - 1}
                      aria-label={t("cws.target.moveDown")}
                      data-cwi-move="down"
                      onClick={() => reorder(index, index + 1, "down")}
                    >
                      <IconArrowDown width={14} height={14} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm cwi-target-remove"
                    disabled={disabled || targets.length <= 1}
                    onClick={() => onChange(targets.filter((_, i) => i !== index))}
                    aria-label={t("common.remove")}
                  >
                    <IconTrash width={14} height={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {strategy === "jev" && (
                <div className="cwi-jev-target-meta">
                  {index === failOpenIndex && <span className="chip">{t("cws.jev.failOpen")}</span>}
                  {selectableReasoningEfforts === undefined
                    ? <span className="muted">{t("cws.jev.effortsUnknown")}</span>
                    : selectableReasoningEfforts.length === 0
                      ? <span className="muted">{t("cws.jev.effortsNone")}</span>
                      : (
                        <fieldset className="cwi-jev-efforts">
                          <legend>{t("cws.jev.allowedEfforts")}</legend>
                          {selectableReasoningEfforts.map((effort) => {
                            const checked = selectedEffortSet.has(effort);
                            return (
                              <label key={effort} className="cwi-jev-effort">
                                <input
                                  type="checkbox"
                                  data-jev-effort
                                  value={effort}
                                  checked={checked}
                                  disabled={disabled || (checked && selectedReasoningEfforts.length === 1)}
                                  onChange={(event) => {
                                    const nextSet = new Set(selectedReasoningEfforts);
                                    if (event.target.checked) nextSet.add(effort);
                                    else nextSet.delete(effort);
                                    update(index, {
                                      reasoningEfforts: selectableReasoningEfforts.filter(candidate => nextSet.has(candidate)),
                                    });
                                  }}
                                />
                                <span>{effort}</span>
                              </label>
                            );
                          })}
                        </fieldset>
                      )}
                  <label className="cwi-field">
                    <span className="field-label">{t("cws.jev.modelProfile")}</span>
                    <textarea
                      className="input"
                      rows={3}
                      maxLength={512}
                      value={row.modelProfile ?? ""}
                      disabled={disabled}
                      placeholder={t("cws.jev.modelProfilePlaceholder")}
                      onChange={(event) => update(index, { modelProfile: event.target.value })}
                    />
                    <span className="muted">{t("cws.jev.modelProfileHint")}</span>
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="btn btn-ghost btn-sm cwi-target-add"
        disabled={disabled}
        onClick={() => onChange([...targets, newComboTarget()])}
      >
        <IconPlus width={14} height={14} aria-hidden="true" /> {t("cws.target.add")}
      </button>
    </>
  );
}
