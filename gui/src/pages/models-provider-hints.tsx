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

/**
 * Shown on a provider group whose live discovery FAILED but which still has rows (#4075).
 *
 * `EmptyProviderHint` above only renders when a group has no rows at all, so a provider with a
 * failed fetch and a manually added model got the amber header badge and nothing else. The badge
 * says discovery failed; it never says that discovery being ON is what keeps those rows out of
 * the picker. That is the whole mechanism the reporter had to find on their own — a newly added
 * key provider is stamped `initialModelSelection.status = "pending"`, failed discovery is
 * degraded so initialization never finalizes, and pending rows are forced disabled and dropped
 * from the Codex catalog. Turning discovery off makes the seed authoritative and releases them.
 *
 * The control name is interpolated from the provider-settings catalog rather than restated, so
 * this sentence names the real switch in all nine locales and cannot drift from its label.
 */
export function DiscoveryDependencyHint() {
  const t = useT();
  return (
    <div className="row muted text-label leading-body" role="status" style={{ alignItems: "flex-start", gap: 8, padding: "6px 0" }}>
      <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        {`${t("models.discoveryFailedDependency", { control: t("pws.liveModels") })} `}
        <button type="button" className="link-btn" onClick={() => navigateHash("providers")}>
          {t("models.openProviderSettings")}
        </button>
      </span>
    </div>
  );
}
