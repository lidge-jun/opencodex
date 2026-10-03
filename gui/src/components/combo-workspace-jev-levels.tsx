import { jevEffectiveFallbackLevel, jevLevelCandidateLabel, type ComboDecisionLevels, type JevLevelId } from "../combo-workspace-data";
import { Trans } from "../i18n/provider";
import { useT } from "../i18n/shared";

/**
 * JEV decision mode selector plus a read-only summary of level mode. Levels are edited through the
 * config file, the CLI, or the API; switching the mode here never touches them.
 */
export function JevDecisionModeField({
  idPrefix,
  comboId,
  decisionMode,
  decisionLevelSelect,
  onSelectChange,
  decisionLevels,
  decisionFallbackLevel,
  staleLevelCandidates = [],
  clearRequested = false,
  disabled,
  onChange,
  onClearLevels,
}: {
  idPrefix: string;
  /** Combo id for the CLI fix shown when stored levels no longer match the targets. */
  comboId: string;
  decisionMode: "level" | undefined;
  decisionLevelSelect?: "route";
  onSelectChange?: (value: "route" | undefined) => void;
  decisionLevels: ComboDecisionLevels | undefined;
  decisionFallbackLevel: JevLevelId | undefined;
  staleLevelCandidates?: readonly string[];
  clearRequested?: boolean;
  disabled?: boolean;
  onChange: (decisionMode: "level" | undefined) => void;
  /** Absent where levels cannot be cleared (a new Combo has none). */
  onClearLevels?: () => void;
}) {
  const t = useT();
  const hasLevels = (decisionLevels?.length ?? 0) > 0;
  const level = decisionMode === "level";
  const fixCommand = "ocx combo set <id> --decision-levels '<json>'".replace("<id>", comboId || "<id>");
  return (
    <div className="cwi-field">
      <label htmlFor={`${idPrefix}-decision-mode`}>{t("cws.jev.decisionMode")}</label>
      <select
        id={`${idPrefix}-decision-mode`}
        className="input"
        value={level ? "level" : "route"}
        disabled={disabled}
        aria-describedby={`${idPrefix}-decision-mode-hint`}
        onChange={(e) => onChange(e.target.value === "level" ? "level" : undefined)}
      >
        <option value="route">{t("cws.jev.decisionModeRoute")}</option>
        {/* Level mode is only valid with stored levels; a stored level mode stays selectable. */}
        <option value="level" disabled={!hasLevels && !level}>{t("cws.jev.decisionModeLevel")}</option>
      </select>
      <p id={`${idPrefix}-decision-mode-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        {t("cws.jev.decisionModeHint")} {!hasLevels && t("cws.jev.decisionModeNoLevels")}
      </p>
      {level && onSelectChange && (
        <div className="cwi-field">
          <label htmlFor={`${idPrefix}-level-select`}>{t("cws.jev.levelSelect")}</label>
          <select
            id={`${idPrefix}-level-select`}
            className="input"
            value={decisionLevelSelect ?? "order"}
            disabled={disabled}
            aria-describedby={`${idPrefix}-level-select-hint`}
            onChange={(e) => onSelectChange(e.target.value === "route" ? "route" : undefined)}
          >
            <option value="order">{t("cws.jev.levelSelectOrder")}</option>
            <option value="route">{t("cws.jev.levelSelectRoute")}</option>
          </select>
          <p id={`${idPrefix}-level-select-hint`} className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>{t("cws.jev.levelSelectHint")}</p>
        </div>
      )}
      {staleLevelCandidates.length > 0 && (
        <p role="alert" data-jev-levels-stale style={{ fontSize: 12, margin: "8px 0 0", color: "var(--danger, #b42318)" }}>
          <Trans k="cws.jev.levelsStale" cmd={fixCommand} vars={{ candidates: staleLevelCandidates.join(", ") }} />
        </p>
      )}
      {!level && hasLevels && onClearLevels && (
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          {t("cws.jev.levelsStored", { count: decisionLevels!.length })}{" "}
          <button type="button" className="btn btn-sm" data-jev-levels-clear disabled={disabled} onClick={onClearLevels}>
            {t("cws.jev.levelsClear")}
          </button>
        </p>
      )}
      {clearRequested && (
        <p className="muted" data-jev-levels-cleared style={{ fontSize: 12, margin: "8px 0 0" }}>{t("cws.jev.levelsCleared")}</p>
      )}
      {level && hasLevels && (
        <section className="pwi-section" aria-label={t("cws.jev.levelsTitle")} data-jev-levels style={{ marginTop: 8 }}>
          <h4 className="pwi-section-title" style={{ fontSize: 13 }}>{t("cws.jev.levelsTitle")}</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {decisionLevels!.map(entry => (
              <li key={entry.id} data-level={entry.id}>
                <code>{entry.id}</code>{" "}
                {/* Validation keeps provider/model/effort unique within a level, so the label is a key. */}
                {entry.candidates.map(candidate => (
                  <code key={jevLevelCandidateLabel(candidate)} className="chip" style={{ marginRight: 4 }}>
                    {jevLevelCandidateLabel(candidate)}
                  </code>
                ))}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }} data-fallback-level>
            {t("cws.jev.levelFallback", { level: jevEffectiveFallbackLevel({ decisionFallbackLevel }) })}
          </p>
          <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>{t("cws.jev.levelsEditHint")}</p>
        </section>
      )}
    </div>
  );
}
