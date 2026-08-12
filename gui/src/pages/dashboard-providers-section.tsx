import { Trans } from "../i18n/provider";
import type { TFn } from "../i18n/shared";
import { EmptyState } from "../ui";
import { formatProviderDisplayName } from "../provider-icons";
import type { ProviderInfo } from "./dashboard-shared";

export function DashboardProvidersSection({
  t,
  providers,
}: {
  t: TFn;
  providers: ProviderInfo[];
}) {
  return (
    <>
      <div className="h-section">{t("dash.activeProviders")} <span className="count">{providers.length}</span></div>
      {providers.length === 0 ? (
        <EmptyState title={<Trans k="dash.noProviders" cmd="ocx init" />} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>{t("dash.col.name")}</th><th>{t("dash.col.adapter")}</th><th>{t("dash.col.baseUrl")}</th><th>{t("dash.col.model")}</th></tr></thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.name}>
                  <td className="font-semibold">{formatProviderDisplayName(p.name, t)}</td>
                  <td><span className="chip">{p.adapter}</span></td>
                  <td className="muted mono text-label">{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
