import { useT, type TKey } from "../../i18n/shared";
import { IconExternal } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { matchingWorkspacePreset, type CatalogPreset } from "../provider-catalog/provider-presets";

type SponsorBrand = { name: string; title: TKey; description: TKey };

const ORCAROUTER: SponsorBrand = {
  name: "OrcaRouter", title: "pws.sponsor.orcaTitle", description: "pws.sponsor.orcaDescription",
};

/**
 * One row per sponsor preset id. The registry `sponsor` field decides whether a card shows;
 * this table only supplies the brand name and localized copy, so a preset flagged as a sponsor
 * without a row here still renders nothing rather than borrowing another sponsor's words.
 */
const SPONSOR_BRANDS: Readonly<Record<string, SponsorBrand>> = {
  orcarouter: ORCAROUTER,
  "orcarouter-oauth": ORCAROUTER,
  packycode: { name: "PackyCode", title: "pws.sponsor.packyTitle", description: "pws.sponsor.packyDescription" },
  tokenlab: { name: "TokenLab", title: "pws.sponsor.tokenlabTitle", description: "pws.sponsor.tokenlabDescription" },
};

function webLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? value : undefined;
  } catch { return undefined; }
}

/** Presentation only: sponsorship never changes routing or account state. */
export default function ProviderSponsor({ item, preset }: { item: WorkspaceItem; preset?: CatalogPreset }) {
  const t = useT();
  if (!preset?.sponsor || !matchingWorkspacePreset(item, [preset])) return null;
  const brand = Object.hasOwn(SPONSOR_BRANDS, preset.id) ? SPONSOR_BRANDS[preset.id] : undefined;
  if (!brand) return null;
  const visit = webLink(preset.sponsorUrl);
  const dashboard = webLink(preset.dashboardUrl);

  return <section className="pws-sponsor" aria-label={`${brand.name} · ${t("modal.badge.sponsor")}`}>
    <div className="pws-sponsor-copy">
      <div className="pws-sponsor-byline">
        <span>{brand.name}</span>
        <span className="pws-sponsor-badge">{t("modal.badge.sponsor")}</span>
      </div>
      <h3>{t(brand.title)}</h3>
      <p>{t(brand.description)}</p>
    </div>
    {(visit || dashboard) && <div className="pws-sponsor-actions">
      {visit && <a className="btn btn-primary" href={visit} target="_blank" rel="noopener noreferrer">
        {t("pws.sponsor.visit", { provider: brand.name })}<IconExternal width={14} height={14} aria-hidden="true" />
      </a>}
      {dashboard && dashboard !== visit && <a className="pws-sponsor-console" href={dashboard} target="_blank" rel="noopener noreferrer">
        {t("pws.sponsor.console")}<IconExternal width={13} height={13} aria-hidden="true" />
      </a>}
    </div>}
  </section>;
}
