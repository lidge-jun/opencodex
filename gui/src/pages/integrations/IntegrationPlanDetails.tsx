import { useT, type TKey } from "../../i18n/shared";
import type { FileIntegrationClientId, IntegrationMutationPlan, IntegrationPlanChangeKind, IntegrationPlanForeignEdit, IntegrationPlanOperation } from "./integration-api";

export interface LabeledIntegrationPlan {
  clientId: FileIntegrationClientId;
  label: string;
  plan: IntegrationMutationPlan;
}

const OPERATION_KEYS: Record<IntegrationPlanOperation, TKey> = {
  apply: "integrations.plan.operation.apply",
  overwrite: "integrations.plan.operation.overwrite",
  disable: "integrations.plan.operation.disable",
  restore: "integrations.plan.operation.restore",
};

const CHANGE_KEYS: Record<IntegrationPlanChangeKind, TKey> = {
  add: "integrations.plan.change.add",
  replace: "integrations.plan.change.replace",
  remove: "integrations.plan.change.remove",
  snapshot: "integrations.plan.change.snapshot",
  ownership: "integrations.plan.change.ownership",
  journal: "integrations.plan.change.journal",
};

const FOREIGN_EDIT_KEYS: Record<IntegrationPlanForeignEdit, TKey> = {
  none: "integrations.plan.foreign.none",
  unowned: "integrations.plan.foreign.unowned",
  "foreign-edit": "integrations.plan.foreign.foreignEdit",
  drift: "integrations.plan.foreign.drift",
};

const REFUSAL_KEYS: Partial<Record<string, TKey>> = {
  not_installed: "integrations.plan.refusal.notInstalled",
  conflict: "integrations.plan.refusal.conflict",
  unsafe: "integrations.plan.refusal.unsafe",
  non_loopback: "integrations.plan.refusal.nonLoopback",
  superseded_store: "integrations.plan.refusal.supersededStore",
  drift_requires_confirm: "integrations.plan.refusal.driftRequiresConfirm",
  snapshot_expired: "integrations.plan.refusal.snapshotExpired",
  write_failed: "integrations.plan.refusal.writeFailed",
};

function Plan({ plan, missingStorePath }: { plan: IntegrationMutationPlan; missingStorePath?: string }) {
  const t = useT();
  const refusalKey = plan.refusalReason ? REFUSAL_KEYS[plan.refusalReason] : undefined;
  // A missing store is the one superseded refusal the operator fixes by hand, so it names the fix.
  // The plan names no file; a caller holding the status row passes its path, because the open
  // dialog covers the status notice that would otherwise say where to create it.
  const missingDocument = plan.supersededReason === "missing-store" ? plan.missingStoreDocument : undefined;
  const refusal = missingDocument === undefined
    ? t(refusalKey ?? "integrations.plan.refused")
    : missingStorePath === undefined
      ? t("integrations.plan.refusal.missingStore", { document: missingDocument })
      : t("integrations.status.missingStore", { path: missingStorePath, document: missingDocument });
  return (
    <div className="integration-plan-details">
      <p className="integration-plan-operation">
        {t("integrations.plan.operation", { operation: t(OPERATION_KEYS[plan.operation]) })}
      </p>
      {plan.foreignEdit !== "none" && <p>{t(FOREIGN_EDIT_KEYS[plan.foreignEdit])}</p>}
      {!plan.willChange && plan.canApply && (
        <>
          <p>{t(plan.operation === "disable" ? "integrations.plan.noop.disabled" : "integrations.plan.noop.applied")}</p>
          {plan.profileId !== undefined && <p>{t("integrations.plan.noop.profilePreference")}</p>}
        </>
      )}
      {!plan.canApply && <p>{refusal}</p>}
      {plan.changes.length > 0 && (
        <ul className="integration-plan-changes">
          {plan.changes.map(change => (
            <li key={`${change.kind}:${change.path}`}>
              <span>{t(CHANGE_KEYS[change.kind])}</span> <code>{change.path}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function IntegrationPlanDetails({
  plan,
  plans,
  missingStorePath,
}: {
  plan?: IntegrationMutationPlan | null;
  plans?: readonly LabeledIntegrationPlan[];
  /** The single plan's client: where its missing store belongs, from the status row. */
  missingStorePath?: string;
}) {
  const t = useT();
  if (!plan && (!plans || plans.length === 0)) return null;
  return (
    <section className="integration-plan" aria-labelledby="integration-plan-heading">
      <h4 id="integration-plan-heading">{t("integrations.plan.heading")}</h4>
      {plan && <Plan plan={plan} missingStorePath={missingStorePath} />}
      {plans?.map(item => (
        <section key={`${item.clientId}:${item.plan.fingerprint}`} className="integration-plan-group">
          <h5>{item.label}</h5>
          <Plan plan={item.plan} />
        </section>
      ))}
    </section>
  );
}
