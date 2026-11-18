import type { PhysicalSendReporter, SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import type { ErrorDestinationLabel } from "../../lib/error-destination";

/** Retry thunks can fail in pacing; settle only starts admitted at the physical executor. */
export function deferPhysicalSendReporter(physical: PhysicalSendReporter) {
  let dispatched = 0;
  let reported = 0;
  const report: PhysicalSendReporter = () => {
    const count = dispatched - reported;
    if (count <= 0) return;
    physical(count);
    reported += count;
  };
  // The retry helper owns attempts, while the physical callback owns spend admission.
  report.beforeSend = () => true;
  report.execute = physical.execute;
  report.close = () => { report(0); physical.close?.(); };
  return {
    report,
    beforeDispatch(): boolean {
      if (physical.beforeSend && !physical.beforeSend()) return false;
      dispatched++;
      return true;
    },
  };
}

/** Keep legacy reporting unless a negotiated leg confirms its reservation at the physical send. */
export function physicalSendAccounting(reporter: PhysicalSendReporter, deferred?: {
  destination: () => ErrorDestinationLabel; permit?: SingleUseDispatchPermit;
}) {
  const pending = deferred ? deferPhysicalSendReporter(reporter) : undefined;
  let permitDispatched = false;
  return { report: pending?.report ?? reporter, onPhysicalDispatch: pending ? () => {
    if (permitDispatched) throw new SendBudgetExhaustedError(deferred!.destination());
    if (!pending.beforeDispatch() || deferred?.permit && !deferred.permit.use()) {
      throw new SendBudgetExhaustedError(deferred!.destination());
    }
    permitDispatched = Boolean(deferred?.permit);
  } : undefined };
}
