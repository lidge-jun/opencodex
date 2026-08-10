import { IconInfo } from "../icons";
import { useT } from "../i18n/shared";
import { navigateHash } from "../hash-routing";
import type { ProviderDiscoverySummary } from "../models-groups";
import { discoveryFailureLabel } from "./models-shared";

export function EmptyProviderHint({
  liveModels,
  discovery,
  showFailureBadge = true,
}: {
  liveModels: boolean;
  discovery?: ProviderDiscoverySummary;
  showFailureBadge?: boolean;
}) {
  const t = useT();
  const failed = liveModels && discovery?.status === "failed" ? discovery : undefined;
  return (
    <div className="row muted text-label leading-body" role="status" style={{ alignItems: "flex-start", gap: 8, padding: "6px 0" }}>
      <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        {failed && showFailureBadge && <><span className="badge badge-amber">{t("models.discoveryFailedBadge")}</span>{" "}</>}
        {failed
          ? `${discoveryFailureLabel(t, failed)} `
          : `${t(liveModels ? "models.emptyDiscovery" : "models.emptyDiscoveryDisabled")} `}
        <button type="button" className="link-btn" onClick={() => navigateHash("providers")}>
          {t("models.openProviderSettings")}
        </button>
      </span>
    </div>
  );
}
