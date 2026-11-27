import type { ComboEffort, ComboStrategy, ComboTarget } from "../combo-workspace-data";
import { comboImageBlockedTargets, comboImagesSupported, comboVisionSidecarTargets } from "../combo-capabilities";
import {
  COMBO_EFFORTS,
  COMBO_STRATEGIES,
  COMBO_STRATEGY_LABEL_KEYS,
} from "../combo-workspace-data";
import { navigateHash } from "../hash-routing";
import { useT } from "../i18n/shared";
import { Select, Switch } from "../ui";
import type { ModelOption } from "./combo-workspace-types";

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
      {COMBO_STRATEGIES.map((id) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`btn btn-sm${value === id ? " btn-primary" : " btn-ghost"}`}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {t(COMBO_STRATEGY_LABEL_KEYS[id])}
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
      <Select
        id={id}
        fullWidth
        value={value ?? ""}
        disabled={disabled}
        label={t("cws.field.defaultEffort")}
        onChange={(next) => onChange(next === "" ? null : next as ComboEffort)}
        options={[
          { value: "", label: t("cws.field.defaultEffortNone") },
          ...(unsupported && value ? [{ value, label: `${value} (${t("cws.field.defaultEffortUnsupportedOption")})` }] : []),
          ...options.map((effort) => ({ value: effort, label: effort })),
        ]}
      />
      {unsupported ? (
        <p className="muted" style={{ fontSize: 12, margin: "4px 0 0", color: "var(--danger, #b42318)" }}>
          {t("cws.field.defaultEffortUnsupported")}
        </p>
      ) : null}
    </>
  );
}


export function ComboCapabilities({
  targets,
  models,
  imageInput,
  reasoningEffortMode,
  visionEnabled,
  disabled,
  onChange,
}: {
  targets: ComboTarget[];
  models: ModelOption[];
  imageInput: "auto" | "disabled";
  reasoningEffortMode: "strict" | "adaptive";
  /** Vision Sidecar enabled state; undefined = unknown, renders no warning. */
  visionEnabled?: boolean;
  disabled?: boolean;
  onChange: (patch: { imageInput?: "auto" | "disabled"; reasoningEffortMode?: "strict" | "adaptive" }) => void;
}) {
  const t = useT();
  const imagesSupported = comboImagesSupported(targets, models);
  const blockedTargets = comboImageBlockedTargets(targets, models);
  // Default: checked (auto) when supported; force off when any target lacks image.
  const effectiveOn = imagesSupported && imageInput !== "disabled";
  const sidecarTargets = comboVisionSidecarTargets(targets, models);
  // Enrollment wording only while image input is enabled: a disabled combo is not
  // enrolling anything, so it gets the plain hint instead of save-time promises.
  const imageHint = !imagesSupported
    ? blockedTargets.length > 0
      ? t("cws.capability.imageInputBlockedHint", {
        models: blockedTargets.map(({ provider, model }) => `${provider}/${model}`).join(", "),
      })
      : t("cws.capability.imageInputUnavailable")
    : sidecarTargets.length > 0 && imageInput !== "disabled"
      ? t("cws.capability.imageInputSidecarHint", {
        models: sidecarTargets.map(({ provider, model }) => `${provider}/${model}`).join(", "),
      })
      : t("cws.capability.imageInputHint");

  return (
    <section className="cwi-capabilities" aria-label={t("cws.capabilities")}>
      <span className="field-label">{t("cws.capabilities")}</span>
      <div className="cwi-capability-row">
        <div>
          <span className="cwi-capability-label">{t("cws.capability.imageInput")}</span>
          <p className="muted cwi-capability-hint">
            {imageHint}
          </p>
          {sidecarTargets.length > 0 && effectiveOn && visionEnabled === false ? (
            <p className="cwi-capability-hint cwi-capability-hint--warn">
              {t("cws.capability.imageInputSidecarDisabled", {
                models: sidecarTargets.map(({ provider, model }) => `${provider}/${model}`).join(", "),
              })}{" "}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash("dashboard")}>
                {t("nav.dashboard")}
              </button>
            </p>
          ) : null}
        </div>
        <Switch
          on={effectiveOn}
          onClick={() => {
            if (!imagesSupported) return;
            onChange({ imageInput: imageInput === "auto" ? "disabled" : "auto" });
          }}
          disabled={disabled || !imagesSupported}
          label={t("cws.capability.imageInput")}
        />
      </div>
      <div className="cwi-capability-row">
        <div>
          <span className="cwi-capability-label">{t("cws.capability.adaptiveEffort")}</span>
          <p className="muted cwi-capability-hint">{t("cws.capability.adaptiveEffortHint")}</p>
        </div>
        <Switch
          on={reasoningEffortMode === "adaptive"}
          onClick={() => {
            onChange({ reasoningEffortMode: reasoningEffortMode === "adaptive" ? "strict" : "adaptive" });
          }}
          disabled={disabled}
          label={t("cws.capability.adaptiveEffort")}
        />
      </div>
    </section>
  );
}
