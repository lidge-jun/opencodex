import { useState } from "react";
import { useT } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { ProviderIcon } from "../provider-workspace/ProviderRail";

/**
 * "Exclude a provider…" under the suggestions' title, after Magpie's 排除供应商 on its found
 * groups: a text button naming who is left out opens a list of providers, each ticked or not.
 * A ticked provider joins no suggested combo; unticking restores it. Saved to config.json.
 */
export function SuggestionExcludeProviders({
  providers,
  excluded,
  onChange,
}: {
  /** Provider names that can be left out, in display order. */
  providers: readonly string[];
  excluded: readonly string[];
  onChange: (next: readonly string[]) => Promise<boolean>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // An excluded provider that was since removed still lists, so it can be restored.
  const names = [...providers, ...excluded.filter((name) => !providers.includes(name))];
  const label = (name: string) => formatProviderDisplayName(name, t);

  const toggle = async (name: string, exclude: boolean) => {
    setBusy(true);
    setFailed(false);
    const next = exclude ? [...excluded, name] : excluded.filter((entry) => entry !== name);
    const ok = await onChange(next);
    setBusy(false);
    if (!ok) setFailed(true);
  };

  return (
    <div className="rb-suggest-exclude">
      <button
        type="button"
        className="btn btn-ghost btn-sm rb-suggest-exclude-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {excluded.length > 0
          ? t("comboSuggest.exclude.active", { names: excluded.map(label).join(", ") })
          : t("comboSuggest.exclude.button")}
      </button>
      {open && (
        <fieldset className="rb-suggest-exclude-panel" disabled={busy}>
          <legend>{t("comboSuggest.exclude.head")}</legend>
          <p className="rb-suggest-hint">{t("comboSuggest.exclude.hint")}</p>
          <ul>
            {names.map((name) => {
              const on = excluded.includes(name);
              return (
                <li key={name}>
                  <label>
                    <input type="checkbox" checked={on} onChange={(event) => void toggle(name, event.target.checked)} />
                    <ProviderIcon name={name} cls="provider-icon provider-icon-sm" />
                    <span>{label(name)}</span>
                  </label>
                  {on && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void toggle(name, false)}>
                      {t("comboSuggest.exclude.restore")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {failed && <p className="rb-row-message" role="alert">{t("comboSuggest.exclude.saveFailed")}</p>}
        </fieldset>
      )}
    </div>
  );
}
