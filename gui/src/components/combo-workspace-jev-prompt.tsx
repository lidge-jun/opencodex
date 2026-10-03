import {
  JEV_EFFORT_DEFAULT_PROFILES,
  JEV_LEVEL_DEFAULT_DESCRIPTIONS,
  JEV_LEVEL_INSTRUCTIONS,
  JEV_PROMPT_MAX_FIELD_CHARS,
  JEV_ROUTE_DEFAULT_INSTRUCTIONS,
  type JevDecisionPrompt,
} from "../../../src/combos/jev-decision-contract";
import type { ComboDecisionLevels } from "../combo-workspace-data";
import { useT, type TKey } from "../i18n/shared";

const PROMPT_ID_SUFFIX = "-prompt-";

const ROUTE_LABELS: Record<keyof typeof JEV_ROUTE_DEFAULT_INSTRUCTIONS, TKey> = {
  question: "cws.jev.promptQuestion",
  objective: "cws.jev.promptObjective",
  evidence: "cws.jev.promptEvidence",
  neutrality: "cws.jev.promptNeutrality",
  speed: "cws.jev.promptSpeed",
};

/** Effective service wording, separate from the read-only candidate projection. */
export function JevDecisionPromptFields({ idPrefix, decisionMode, decisionPrompt, decisionLevels, disabled, onChange }: {
  idPrefix: string;
  decisionMode?: "level";
  decisionPrompt?: JevDecisionPrompt;
  decisionLevels?: ComboDecisionLevels;
  disabled?: boolean;
  onChange: (patch: { decisionPrompt?: JevDecisionPrompt; decisionLevels?: ComboDecisionLevels; decisionLevelsEdited?: true }) => void;
}) {
  const t = useT();
  function field(name: string, label: string, value: string | undefined, fallback: string, update: (value: string | undefined) => void) {
    const id = `${idPrefix}${PROMPT_ID_SUFFIX}${name}`;
    return (
      <div className="cwi-field" key={name}>
        <label htmlFor={id}>{label}</label>
        <textarea
          id={id}
          className="input"
          rows={3}
          maxLength={JEV_PROMPT_MAX_FIELD_CHARS}
          disabled={disabled}
          value={value ?? fallback}
          placeholder={fallback}
          onChange={(event) => update(event.target.value.trim() === fallback ? undefined : event.target.value)}
        />
        <button type="button" className="btn btn-sm" data-prompt-reset={name} disabled={disabled || value === undefined} onClick={() => update(undefined)}>
          {t("cws.jev.promptReset")}
        </button>
      </div>
    );
  }
  return (
    <details className="cwi-field" data-jev-decision-prompt>
      <summary>{t("cws.jev.promptTitle")}</summary>
      <p className="muted">{t("cws.jev.promptHint")}</p>
      {decisionMode === "level" ? (
        <>
          {field("level", t("cws.jev.promptLevel"), decisionPrompt?.levelInstructions, JEV_LEVEL_INSTRUCTIONS,
            value => onChange({ decisionPrompt: { ...decisionPrompt, levelInstructions: value } }))}
          {decisionLevels?.map(level => field(`description-${level.id}`, t("cws.jev.promptDescription", { level: level.id }), level.description, JEV_LEVEL_DEFAULT_DESCRIPTIONS[level.id],
            value => onChange({
              decisionLevels: decisionLevels.map(entry => {
                if (entry.id !== level.id) return entry;
                const { description: _description, ...rest } = entry;
                return { ...rest, ...(value ? { description: value } : {}) };
              }),
              decisionLevelsEdited: true,
            })))}
        </>
      ) : (
        <>
          {(Object.keys(JEV_ROUTE_DEFAULT_INSTRUCTIONS) as Array<keyof typeof JEV_ROUTE_DEFAULT_INSTRUCTIONS>).map(key => field(key, t(ROUTE_LABELS[key]), decisionPrompt?.route?.[key], JEV_ROUTE_DEFAULT_INSTRUCTIONS[key],
            value => onChange({ decisionPrompt: { ...decisionPrompt, route: { ...decisionPrompt?.route, [key]: value } } })))}
          {(Object.keys(JEV_EFFORT_DEFAULT_PROFILES) as Array<keyof typeof JEV_EFFORT_DEFAULT_PROFILES>).map(effort => field(`effort-${effort}`, t("cws.jev.promptEffort", { effort }), decisionPrompt?.route?.effortProfiles?.[effort], JEV_EFFORT_DEFAULT_PROFILES[effort],
            value => onChange({ decisionPrompt: { ...decisionPrompt, route: { ...decisionPrompt?.route, effortProfiles: { ...decisionPrompt?.route?.effortProfiles, [effort]: value } } } })))}
        </>
      )}
    </details>
  );
}
