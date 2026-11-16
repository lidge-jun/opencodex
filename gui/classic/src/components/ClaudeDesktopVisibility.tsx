import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/shared";
import { Notice } from "../ui";
import { LANE_PAGE } from "../pages/claude-desktop-lane";
import {
  applyPreview,
  desiredDesktopList,
  filterVisibilityModels,
  providerOf,
  providersOf,
  routeVisible,
  setNewModelPolicy,
  setRoutesVisible,
  visibilityCounts,
  type AppliedDesktopModel,
  type DesktopVisibility,
  type ListedDesktopModel,
  type VisibilityModel,
} from "../pages/claude-desktop-visibility";

/** How many labels the apply preview names before summarizing the rest as a count. */
const PREVIEW_NAMES = 6;

function previewText(labels: string[]): string {
  const shown = labels.slice(0, PREVIEW_NAMES).join(", ");
  return labels.length > PREVIEW_NAMES ? `${shown} +${labels.length - PREVIEW_NAMES}` : shown;
}

/**
 * Per-model Claude Desktop visibility (#7702): which rows the Desktop 3P list carries.
 * Separate from the tier lanes under Advanced; the parent owns the draft and saves it with
 * the profile, so Save and Save & apply cover both.
 */
export default function ClaudeDesktopVisibility<T extends VisibilityModel>({
  models,
  visibility,
  onChange,
  rendered,
  appliedModels,
  disabled,
  badges,
}: {
  /** Rows in display order (the page puts the role holders first). */
  models: readonly T[];
  visibility: DesktopVisibility | null;
  onChange: (next: DesktopVisibility | null) => void;
  /** The full list the next apply would write before visibility, in written order. */
  rendered: readonly ListedDesktopModel[];
  /** What Desktop runs now; null when there is no static list to compare against. */
  appliedModels: readonly AppliedDesktopModel[] | null;
  disabled: boolean;
  badges: (model: T) => ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [limit, setLimit] = useState(LANE_PAGE);
  const providers = useMemo(() => providersOf(models), [models]);
  const shown = useMemo(() => filterVisibilityModels(models, query, provider), [models, query, provider]);
  const counts = visibilityCounts(models, visibility);
  const preview = applyPreview(desiredDesktopList(rendered, visibility), appliedModels);
  const shownRoutes = shown.map(model => model.route);
  const policy = visibility?.mode ?? "exclude";

  return (
    <div className="claude-visibility">
      <div className="claude-visibility-counts" role="status">
        <span className="claude-visibility-count">{t("claudeDesktop.visibility.selected", { n: counts.selected })}</span>
        <span className="claude-visibility-count">{t("claudeDesktop.visibility.available", { n: counts.available })}</span>
        <span className="claude-visibility-count">
          {appliedModels ? t("claudeDesktop.visibility.applied", { n: appliedModels.length }) : t("claudeDesktop.visibility.appliedUnknown")}
        </span>
        {counts.selectedUnavailable > 0 && (
          <span className="claude-visibility-count muted">{t("claudeDesktop.visibility.selectedUnavailable", { n: counts.selectedUnavailable })}</span>
        )}
      </div>

      <fieldset className="claude-visibility-policy" disabled={disabled}>
        <legend>{t("claudeDesktop.visibility.newModels")}</legend>
        {(["exclude", "include"] as const).map(mode => (
          <label key={mode}>
            <input
              type="radio"
              name="claude-desktop-new-models"
              value={mode}
              checked={policy === mode}
              onChange={() => onChange(setNewModelPolicy(visibility, models.map(model => model.route), mode))}
            />
            {mode === "exclude" ? t("claudeDesktop.visibility.newShow") : t("claudeDesktop.visibility.newHide")}
          </label>
        ))}
      </fieldset>

      <div className="claude-visibility-filters">
        <input
          className="input"
          type="search"
          placeholder={t("claudeDesktop.visibility.search")}
          aria-label={t("claudeDesktop.visibility.search")}
          value={query}
          onChange={event => { setQuery(event.target.value); setLimit(LANE_PAGE); }}
        />
        <select
          className="input"
          aria-label={t("claudeDesktop.visibility.provider")}
          value={provider}
          onChange={event => { setProvider(event.target.value); setLimit(LANE_PAGE); }}
        >
          <option value="">{t("claudeDesktop.visibility.allProviders")}</option>
          {providers.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || shown.length === 0}
          onClick={() => onChange(setRoutesVisible(visibility, shownRoutes, true))}>
          {t("claudeDesktop.visibility.selectShown")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || shown.length === 0}
          onClick={() => onChange(setRoutesVisible(visibility, shownRoutes, false))}>
          {t("claudeDesktop.visibility.clearShown")}
        </button>
      </div>

      {counts.selected === 0 && counts.available > 0 && <Notice tone="warn">{t("claudeDesktop.visibility.noneSelected")}</Notice>}

      {shown.length === 0 ? (
        <p className="claude-desktop-list-hint">{t("claudeDesktop.visibility.noMatch")}</p>
      ) : (
        <ul className="card claude-desktop-list-rows">
          {shown.slice(0, limit).map(model => {
            const visible = routeVisible(visibility, model.route);
            return (
              <li key={model.route} className={`claude-desktop-list-row${visible ? "" : " hidden-row"}`}>
                <input
                  type="checkbox"
                  checked={visible}
                  disabled={disabled}
                  aria-label={t("claudeDesktop.visibility.toggle", { model: model.label })}
                  onChange={event => onChange(setRoutesVisible(visibility, [model.route], event.target.checked))}
                />
                <span className="claude-desktop-list-names">
                  <strong title={model.label}>{model.label}</strong>
                  {model.label !== model.route && <code title={model.route}>{model.route}</code>}
                </span>
                <span className="badge badge-muted claude-visibility-provider">{providerOf(model.route)}</span>
                {badges(model)}
              </li>
            );
          })}
        </ul>
      )}
      {shown.length > limit && (
        <button type="button" className="btn btn-ghost btn-sm claude-lane-more" onClick={() => setLimit(current => current + LANE_PAGE)}>
          {t("models.showMore", { n: shown.length - limit })}
        </button>
      )}

      {preview && (
        <div className="claude-visibility-preview">
          <span className="claude-visibility-preview-title">{t("claudeDesktop.visibility.previewTitle")}</span>
          {preview.added.length === 0 && preview.removed.length === 0
            ? <span>{t("claudeDesktop.visibility.previewSame")}</span>
            : (
              <>
                {preview.added.length > 0 && <span className="claude-visibility-added">{t("claudeDesktop.visibility.previewAdds", { models: previewText(preview.added) })}</span>}
                {preview.removed.length > 0 && <span className="claude-visibility-removed">{t("claudeDesktop.visibility.previewRemoves", { models: previewText(preview.removed) })}</span>}
              </>
            )}
        </div>
      )}
      <p className="claude-desktop-list-hint">{t("claudeDesktop.visibility.replaceNote")}</p>
    </div>
  );
}
