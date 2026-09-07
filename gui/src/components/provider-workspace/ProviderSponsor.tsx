import { useT } from "../../i18n/shared";
import { IconExternal } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { matchingWorkspacePreset, type CatalogPreset } from "../provider-catalog/provider-presets";

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
  const brand = preset.id === "orcarouter" || preset.id === "orcarouter-oauth"
    ? "OrcaRouter" : preset.id === "packycode" ? "PackyCode" : undefined;
  if (!brand) return null;
  const orca = brand === "OrcaRouter";
  const visit = webLink(preset.sponsorUrl);
  const dashboard = webLink(preset.dashboardUrl);

  return <section className="pws-sponsor" aria-label={`${brand} · ${t("modal.badge.sponsor")}`}>
    <div className="pws-sponsor-copy">
      <div className="pws-sponsor-byline">
        <span>{brand}</span>
        <span className="pws-sponsor-badge">{t("modal.badge.sponsor")}</span>
      </div>
      <h3>{t(orca ? "pws.sponsor.orcaTitle" : "pws.sponsor.packyTitle")}</h3>
      <p>{t(orca ? "pws.sponsor.orcaDescription" : "pws.sponsor.packyDescription")}</p>
    </div>
    {(visit || dashboard) && <div className="pws-sponsor-actions">
      {visit && <a className="btn btn-primary" href={visit} target="_blank" rel="noopener noreferrer">
        {t("pws.sponsor.visit", { provider: brand })}<IconExternal width={14} height={14} aria-hidden="true" />
      </a>}
      {dashboard && dashboard !== visit && <a className="pws-sponsor-console" href={dashboard} target="_blank" rel="noopener noreferrer">
        {t("pws.sponsor.console")}<IconExternal width={13} height={13} aria-hidden="true" />
      </a>}
    </div>}
  </section>;
}
