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
  drift_requires_confirm: "integrations.plan.refusal.driftRequiresConfirm",
  snapshot_expired: "integrations.plan.refusal.snapshotExpired",
  write_failed: "integrations.plan.refusal.writeFailed",
};

function Plan({ plan }: { plan: IntegrationMutationPlan }) {
  const t = useT();
  const refusalKey = plan.refusalReason ? REFUSAL_KEYS[plan.refusalReason] : undefined;
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
      {!plan.canApply && <p>{t(refusalKey ?? "integrations.plan.refused")}</p>}
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
}: {
  plan?: IntegrationMutationPlan | null;
  plans?: readonly LabeledIntegrationPlan[];
}) {
  const t = useT();
  if (!plan && (!plans || plans.length === 0)) return null;
  return (
    <section className="integration-plan" aria-labelledby="integration-plan-heading">
      <h4 id="integration-plan-heading">{t("integrations.plan.heading")}</h4>
      {plan && <Plan plan={plan} />}
      {plans?.map(item => (
        <section key={`${item.clientId}:${item.plan.fingerprint}`} className="integration-plan-group">
          <h5>{item.label}</h5>
          <Plan plan={item.plan} />
        </section>
      ))}
    </section>
  );
}
