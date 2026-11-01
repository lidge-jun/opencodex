import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import { codexWsIncrementalUploadEnabled } from "./codex-ws-incremental";

export { capturePhysicalSendRecovery } from "../../lib/request-execution-budget";

/** Incremental sends keep the reporter that can settle a delta before admitting recovery. */
export function codexWsReceiptMode(budget: RequestExecutionBudget | undefined, prepaid: boolean): boolean {
  // Otherwise a combo-owned first send uses the physical receipt. Spend enforcement keeps
  // reporter ownership; the combo booking already froze that policy before this selection.
  return !budget?.spendEnforced && prepaid && !codexWsIncrementalUploadEnabled();
}
