import { Trans } from "../i18n/provider";
import type { TFn } from "../i18n/shared";
import { EmptyState } from "../ui";
import { formatProviderDisplayName } from "../provider-icons";
import type { ProviderInfo } from "./dashboard-shared";

function providerStatusColor(p: ProviderInfo): { color: string; bg: string } {
  if (p.disabled) return { color: "var(--muted)", bg: "var(--raised)" };
  if (p.discovery?.status === "failed") return { color: "var(--red)", bg: "var(--red-soft)" };
  if (p.discovery?.status === "ok") return { color: "var(--green)", bg: "var(--green-soft)" };
  return { color: "var(--muted)", bg: "var(--raised)" };
}

function providerStatusLabel(p: ProviderInfo, t: TFn): string {
  if (p.disabled) return t("dash.providerStatus.disabled");
  if (p.discovery?.status === "failed") return t("dash.providerStatus.error");
  if (p.discovery?.status === "ok") return t("dash.providerStatus.ok");
  return t("dash.providerStatus.unknown");
}

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
            <thead><tr><th>{t("dash.col.name")}</th><th>{t("dash.col.adapter")}</th><th>{t("dash.col.baseUrl")}</th><th>{t("dash.col.model")}</th><th>{t("dash.col.status")}</th></tr></thead>
            <tbody>
              {providers.map(p => {
                const s = providerStatusColor(p);
                return (
                  <tr key={p.name}>
                    <td className="font-semibold">{formatProviderDisplayName(p.name, t)}</td>
                    <td><span className="chip">{p.adapter}</span></td>
                    <td className="muted mono text-label">{p.baseUrl}</td>
                    <td className="muted">{p.defaultModel ?? "—"}</td>
                    <td><span className="chip" style={{ color: s.color, background: s.bg }}>{providerStatusLabel(p, t)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
