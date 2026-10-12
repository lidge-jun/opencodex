import { useMemo, useState } from "react";
import { IconChevron, IconX } from "../icons";
import { Notice } from "../ui";
import { useI18n } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";

/** The slice of DesktopModel this card needs; the page's full model is compatible. */
export interface FirstPartyBindingModel {
  route: string;
  label: string;
  available: boolean;
}

/** The page's labels already name the provider ("glm-5.3-flash (zai)"); fall back to the route. */
function routeOptionLabel(model: FirstPartyBindingModel): string {
  return model.label || model.route;
}

/**
 * First-party "Code tab model bindings" card. Claude Desktop keeps Anthropic's
 * picker ids; each binding maps one picker id to an OpenCodex route. Every edit
 * saves immediately through PUT /api/claude-desktop/first-party-bindings — there
 * is no draft, because the bindings live on the server, not in the profile.
 */
export default function ClaudeFirstPartyBindings({
  apiBase,
  bindings,
  suggestions,
  models,
  onSaved,
}: {
  apiBase: string;
  /** Server-reported bindings (or the parent's post-PUT override). */
  bindings: Record<string, string>;
  /** Picker ids the backend suggests for the datalist. */
  suggestions: string[];
  /** Route options; only available models are offered for new choices. */
  models: FirstPartyBindingModel[];
  /** Receives the PUT response bindings so the parent can mirror them and refresh status. */
  onSaved: (next: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const [pickerId, setPickerId] = useState("");
  const [route, setRoute] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const routes = useMemo(() => models.filter(model => model.available), [models]);
  const boundIds = useMemo(() => new Set(Object.keys(bindings)), [bindings]);
  const unboundSuggestions = useMemo(
    () => suggestions.filter(id => !boundIds.has(id)),
    [suggestions, boundIds],
  );
  const sortedBindings = useMemo(() => Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)), [bindings]);

  const trimmedId = pickerId.trim();
  const canAdd = trimmedId.startsWith("claude-") && route !== "" && pending === null;

  const save = async (body: { set?: Record<string, string>; remove?: string[] }, pendingKey: string) => {
    if (pending !== null) return;
    setPending(pendingKey);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop/first-party-bindings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await readJsonOrThrow<{ ok?: boolean; modelBindings?: Record<string, string> }>(
        response,
        t("claudeDesktop.firstParty.bindings.saveFailed"),
      );
      if (!payload || payload.ok !== true || typeof payload.modelBindings !== "object" || payload.modelBindings === null) {
        throw new Error(t("claudeDesktop.firstParty.bindings.saveFailed"));
      }
      setPickerId("");
      setRoute("");
      onSaved(payload.modelBindings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("claudeDesktop.firstParty.bindings.saveFailed"));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="claude-bindings" aria-labelledby="claude-bindings-title">
      <h3 id="claude-bindings-title" className="claude-bindings-title">
        {t("claudeDesktop.firstParty.bindings.title")}
      </h3>
      <p className="claude-bindings-hint">{t("claudeDesktop.firstParty.bindings.hint")}</p>

      {error && <Notice tone="err">{error}</Notice>}

      {sortedBindings.length === 0 ? (
        <p className="claude-bindings-empty">{t("claudeDesktop.firstParty.bindings.empty")}</p>
      ) : (
        <ul className="claude-bindings-list">
          {sortedBindings.map(([id, bound]) => {
            const known = routes.some(model => model.route === bound);
            return (
              <li key={id} className="claude-bindings-row">
                <code className="claude-bindings-id" title={id}>{id}</code>
                <IconChevron className="claude-bindings-arrow" width={12} height={12} aria-hidden="true" />
                <select
                  className="input claude-bindings-select"
                  aria-label={t("claudeDesktop.firstParty.bindings.routeLabel")}
                  value={bound}
                  disabled={pending !== null}
                  onChange={event => void save({ set: { [id]: event.target.value } }, id)}
                >
                  {!known && <option value={bound}>{bound}</option>}
                  {routes.map(model => (
                    <option key={model.route} value={model.route}>{routeOptionLabel(model)}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm claude-bindings-remove"
                  aria-label={t("claudeDesktop.firstParty.bindings.remove", { id })}
                  disabled={pending !== null}
                  onClick={() => void save({ remove: [id] }, id)}
                >
                  <IconX width={12} height={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="claude-bindings-add">
        <input
          className="input claude-bindings-input"
          type="text"
          list="claude-bindings-suggestions"
          aria-label={t("claudeDesktop.firstParty.bindings.pickerLabel")}
          placeholder={t("claudeDesktop.firstParty.bindings.pickerPlaceholder")}
          value={pickerId}
          disabled={pending !== null}
          onChange={event => setPickerId(event.target.value)}
        />
        <datalist id="claude-bindings-suggestions">
          {unboundSuggestions.map(id => <option key={id} value={id} />)}
        </datalist>
        <select
          className="input claude-bindings-select"
          aria-label={t("claudeDesktop.firstParty.bindings.routeLabel")}
          value={route}
          disabled={pending !== null}
          onChange={event => setRoute(event.target.value)}
        >
          <option value="">{t("claudeDesktop.firstParty.bindings.routePlaceholder")}</option>
          {routes.map(model => (
            <option key={model.route} value={model.route}>{routeOptionLabel(model)}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canAdd}
          onClick={() => void save({ set: { [trimmedId]: route } }, trimmedId)}
        >
          {pending !== null && pending === trimmedId ? t("common.saving") : t("claudeDesktop.firstParty.bindings.add")}
        </button>
      </div>
    </section>
  );
}
