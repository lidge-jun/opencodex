import type { PhysicalSendReporter } from "../../lib/request-execution-budget";

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
