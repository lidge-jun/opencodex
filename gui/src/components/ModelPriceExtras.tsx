import type { KeyboardEvent, RefObject } from "react";
import { useT } from "../i18n/shared";
import type { ModelRowPrice } from "../pages/models-shared";
import { PRICE_SOURCE_LABEL, adoptableCost, describePrice } from "./model-price-source";

interface AutomaticPriceProps {
  price?: ModelRowPrice;
  locked: boolean;
  refreshing: boolean;
  onAdopt: () => void;
  onRefreshPrices: () => void;
}

/** The row's current automatic price, with adopt-as-manual and a forced catalog refresh. */
export function AutomaticPrice({ price, locked, refreshing, onAdopt, onRefreshPrices }: AutomaticPriceProps) {
  const t = useT();
  const manual = price?.source === "manual";
  return (
    <section className="model-price-auto" aria-label={t("pricing.auto.title")}>
      <h4 className="model-price-band-title">{t("pricing.auto.title")}</h4>
      {manual && <p className="muted small">{t("pricing.auto.manualInEffect")}</p>}
      {!price && <p className="muted small">{t("pricing.auto.none")}</p>}
      {price && !manual && <>
        <p className="small"><strong>{t(PRICE_SOURCE_LABEL[price.source])}</strong></p>
        {describePrice(t, price).slice(1).map(line => <p className="muted small" key={line}>{line}</p>)}
      </>}
      <div className="model-price-auto-actions">
        {price && !manual && <button type="button" className="btn btn-sm" disabled={locked || adoptableCost(price) === null}
          onClick={onAdopt}>{t("pricing.auto.adopt")}</button>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={onRefreshPrices}>
          {t(refreshing ? "pricing.auto.refreshing" : "pricing.auto.refresh")}
        </button>
      </div>
      {price && !manual && <p className="muted small">{t("pricing.auto.adoptHelp")}</p>}
    </section>
  );
}

interface RelayMultiplierProps {
  id: string;
  provider: string;
  draft: string;
  dirty: boolean;
  invalid: boolean;
  locked: boolean;
  saving: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onDraft: (value: string) => void;
  onSave: () => void;
}

export function RelayMultiplier({ id, provider, draft, dirty, invalid, locked, saving, inputRef, onDraft, onSave }: RelayMultiplierProps) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (dirty && !locked) onSave();
  };
  return (
    <section className="model-price-band" aria-labelledby={`${id}-multiplier-title`}>
      <h4 id={`${id}-multiplier-title`} className="model-price-band-title">{t("pricing.multiplier.title", { provider })}</h4>
      <p id={`${id}-multiplier-help`} className="muted small">{t("pricing.multiplier.help")}</p>
      <div className="model-price-multiplier-row">
        <div className="model-price-rate-field">
          <label className="field-label" htmlFor={`${id}-multiplier`}>{t("pricing.multiplier.label")}</label>
          <input ref={inputRef} id={`${id}-multiplier`} className="input" type="number" min={0} max={1000} step="any" inputMode="decimal"
            value={draft} disabled={locked} placeholder={t("pricing.multiplier.placeholder")}
            aria-describedby={`${id}-multiplier-help`} aria-invalid={invalid ? true : undefined}
            onKeyDown={onKeyDown} onChange={event => onDraft(event.target.value)} />
        </div>
        <button type="button" className="btn btn-sm" disabled={locked || !dirty} onClick={onSave}>
          {t(saving ? "pricing.multiplier.saving" : "pricing.multiplier.save")}
        </button>
      </div>
    </section>
  );
}
