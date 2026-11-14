import { useT } from "../i18n/shared";
import type { ModelRowPrice } from "../pages/models-shared";
import { PRICE_SOURCE_LABEL, describePrice, type PriceSourceId } from "./model-price-source";

interface PriceSourceChipProps {
  price?: ModelRowPrice;
  /** Legacy flag on rows from a server that predates `price`. */
  manualPricing?: boolean;
}

export default function PriceSourceChip({ price, manualPricing }: PriceSourceChipProps) {
  const t = useT();
  const source: PriceSourceId = price?.source ?? (manualPricing === true ? "manual" : "unknown");
  const title = price ? describePrice(t, price).join("\n") : t(source === "manual" ? "pricing.override.badge" : "pricing.source.unknownHint");
  return (
    <span className={`models-chip text-caption${source === "manual" || source === "official" ? "" : " muted"}`}
      data-price-source={source} title={title}>
      {t(PRICE_SOURCE_LABEL[source])}
    </span>
  );
}
