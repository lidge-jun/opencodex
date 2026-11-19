import type { RequestExecutionBudget } from "../../lib/request-execution-budget";

export { capturePhysicalSendRecovery } from "../../lib/request-execution-budget";

/** An observe-only combo leg settles its booking at the physical dispatch boundary. */
export function codexWsReceiptMode(budget: RequestExecutionBudget | undefined, prepaid: boolean): boolean {
  return !budget?.spendEnforced && prepaid;
}
