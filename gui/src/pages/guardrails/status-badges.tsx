import { useT } from "../../i18n/shared";
import { guardrailsTrafficProtectionStatus } from "./protection-status";
import type { GuardrailsOverview } from "./types";

function protectionStatus(overview: GuardrailsOverview): {
  className: "badge-green" | "badge-amber" | "badge-muted";
  key:
    | "guardrails.statusProtected"
    | "guardrails.statusDetectOnly"
    | "guardrails.statusReducedCoverage"
    | "guardrails.statusUnavailable"
    | "guardrails.statusNoRules"
    | "guardrails.statusNoProviderCoverage"
    | "guardrails.statusDisabled";
} {
  const trafficProtection = guardrailsTrafficProtectionStatus(overview);
  if (
    trafficProtection === "no-rules"
  ) {
    return { className: "badge-amber", key: "guardrails.statusNoRules" };
  }
  switch (trafficProtection) {
    case "disabled":
      return { className: "badge-muted", key: "guardrails.statusDisabled" };
    case "detect":
      return { className: "badge-amber", key: "guardrails.statusDetectOnly" };
    case "no-provider-coverage":
      return { className: "badge-amber", key: "guardrails.statusNoProviderCoverage" };
    case "reduced":
      return { className: "badge-amber", key: "guardrails.statusReducedCoverage" };
    case "enforce":
      return { className: "badge-green", key: "guardrails.statusProtected" };
    case "unknown":
    case "unavailable":
      return { className: "badge-amber", key: "guardrails.statusUnavailable" };
  }
}

export function GuardrailsStatusBadges({ overview }: { overview: GuardrailsOverview }) {
  const t = useT();
  const lastPassthroughAt = overview.overview.lastPassthroughAt;
  const status = protectionStatus(overview);

  return (
    <div className="guardrails-status">
      <span className={`badge ${status.className}`}>
        {t(status.key)}
      </span>
      {overview.failurePolicy === "passthrough" && (
        <span className="badge badge-amber">{t("guardrails.failurePassthrough")}</span>
      )}
      {lastPassthroughAt !== null && (
        <span className="badge badge-amber">
          {t("guardrails.lastPassthrough", {
            date: new Date(lastPassthroughAt).toLocaleString(),
          })}
        </span>
      )}
    </div>
  );
}
