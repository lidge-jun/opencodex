import { useState } from "react";
import type { ComboEffort, ComboStrategy, ComboTarget } from "../combo-workspace-data";
import { canCopyPublicModelId } from "../combo-public-model";
import { COMBO_EFFORTS, newComboTarget } from "../combo-workspace-data";
import { IconArrowDown, IconArrowUp, IconGrip, IconPlus, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { clampedNumberInput, enabledProviders, modelsForProvider } from "./combo-workspace-utils";
import { useCopyFeedback } from "./use-copy-feedback";

export function StrategySeg({
  value,
  onChange,
  disabled,
}: {
  value: ComboStrategy;
  onChange: (next: ComboStrategy) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="cwi-strategy-seg" role="radiogroup" aria-label={t("cws.strategy")}>
      {([
        ["failover", "cws.strategy.failover"],
        ["round-robin", "cws.strategy.roundRobin"],
      ] as const).map(([id, key]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`btn btn-sm${value === id ? " btn-primary" : " btn-ghost"}`}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

export function EffortSelect({
  id,
  value,
  onChange,
  disabled,
  allowedEfforts,
}: {
  id: string;
  value: ComboEffort | null;
  onChange: (next: ComboEffort | null) => void;
  disabled?: boolean;
  /** When set, only these efforts (plus None) are offered. */
  allowedEfforts?: readonly ComboEffort[];
}) {
  const t = useT();
  const options = allowedEfforts ?? COMBO_EFFORTS;
  const unsupported = value !== null && !options.includes(value);
  return (
    <>
      <select
        id={id}
        className="input"
        value={value ?? ""}
        disabled={disabled}
        aria-label={t("cws.field.defaultEffort")}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value as ComboEffort)}
      >
        <option value="">{t("cws.field.defaultEffortNone")}</option>
        {unsupported && value ? (
          <option value={value}>{value} ({t("cws.field.defaultEffortUnsupportedOption")})</option>
        ) : null}
        {options.map((effort) => (
          <option key={effort} value={effort}>{effort}</option>
        ))}
      </select>
      {unsupported ? (
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0", color: "var(--danger, #b42318)" }}>
          {t("cws.field.defaultEffortUnsupported")}
        </p>
      ) : null}
    </>
  );
}

export function TargetEditor({
  targets,
  strategy,
  providers,
  models,
  onChange,
}: {
  targets: ComboTarget[];
  strategy: ComboStrategy;
  providers: ProviderOption[];
  models: ModelOption[];
  onChange: (next: ComboTarget[]) => void;
}) {
  const t = useT();
  const provs = enabledProviders(providers);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const update = (index: number, patch: Partial<ComboTarget>) => {
    onChange(targets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= targets.length || to >= targets.length) return;
    const copy = [...targets];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved!);
    onChange(copy);
  };

  return (
    <div className="cwi-target-list">
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
        const dragging = dragIndex === index;
        const dropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
        return (
          <div
            key={row.clientKey ?? `${row.provider}:${row.model}`}
            className={[
              "cwi-target-row",
              strategy === "failover" ? "cwi-target-row--failover" : "",
              dragging ? "cwi-target-row--dragging" : "",
              dropTarget ? "cwi-target-row--drop" : "",
            ].filter(Boolean).join(" ")}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overIndex !== index) setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) reorder(dragIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            <button
              type="button"
              className="cwi-target-grip"
              draggable
              aria-label={t("cws.target.drag")}
              title={t("cws.target.drag")}
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(index));
              }}
            >
              <IconGrip width={14} height={14} aria-hidden="true" />
            </button>
            <div className="cwi-target-reorder">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={index === 0}
                aria-label={t("cws.target.moveUp")}
                onClick={() => reorder(index, index - 1)}
              >
                <IconArrowUp width={14} height={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={index === targets.length - 1}
                aria-label={t("cws.target.moveDown")}
                onClick={() => reorder(index, index + 1)}
              >
                <IconArrowDown width={14} height={14} aria-hidden="true" />
              </button>
            </div>
            <select
              className="input"
              value={row.provider}
              aria-label={t("cws.target.provider")}
              onChange={(e) => {
                const provider = e.target.value;
                const first = modelsForProvider(models, provider, providers)[0] ?? "";
                update(index, { provider, model: first });
              }}
            >
              <option value="">{t("cws.target.pickProvider")}</option>
              {providerOptions.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.disabled ? t("cws.target.disabled", { name: formatProviderDisplayName(p.name, t) }) : formatProviderDisplayName(p.name, t)}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={row.model}
              disabled={modelSelectDisabled}
              aria-label={t("cws.target.model")}
              onChange={(e) => update(index, { model: e.target.value })}
            >
              <option value="">
                {modelSelectDisabled
                  ? t("cws.target.pickProviderFirst")
                  : options.length === 0
                    ? t("cws.target.noModels")
                    : t("cws.target.pickModel")}
              </option>
              {options.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            {strategy === "round-robin" && (
              <input
                className="input mono"
                type="number"
                min={1}
                max={10000}
                value={row.weight ?? 1}
                aria-label={t("cws.target.weight")}
                onChange={(e) => {
                  const weight = clampedNumberInput(e.target.value, 1, 10000);
                  if (weight === undefined) return;
                  update(index, { weight });
                }}
              />
            )}
            <div className="cwi-target-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={targets.length <= 1}
                onClick={() => onChange(targets.filter((_, i) => i !== index))}
                aria-label={t("common.remove")}
              >
                <IconTrash width={14} height={14} />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: "flex-start" }}
        onClick={() => onChange([...targets, newComboTarget()])}
      >
        <IconPlus width={14} height={14} /> {t("cws.target.add")}
      </button>
    </div>
  );
}

/** Effective public model id clients will request — mono value + copy. */
export function PublicModelPreview({ model }: { model: string }) {
  const t = useT();
  const { outcomeFor, copy } = useCopyFeedback<string>();
  const canCopy = canCopyPublicModelId(model);
  const outcome = outcomeFor(model);
  const copyLabel = outcome === "copied"
    ? t("cws.copiedPublicModel")
    : outcome === "unavailable"
      ? t("cws.copyUnavailable")
      : t("cws.copyPublicModel");
  // Split around a sentinel so the model token stays mono in any locale word order.
  const sentinel = "\u0001";
  const [before, after = ""] = t("cws.field.publicModelPreview", { model: sentinel }).split(sentinel);

  return (
    <div className="cwi-public-model-preview">
      <p className="muted cwi-public-model-preview-text">
        {before}
        <code className="mono cwi-public-model-preview-value">{model}</code>
        {after}
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-sm cwi-public-model-preview-copy"
        disabled={!canCopy}
        onClick={() => {
          if (canCopy) copy(model, model);
        }}
        title={copyLabel}
      >
        <span aria-live="polite">{copyLabel}</span>
      </button>
    </div>
  );
}
