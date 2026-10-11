import { formatErrorResponse } from "../../bridge";
import { SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE } from "../../lib/errors";
import { markLocalRequestLogRefusal, type RequestLogContext } from "../request-log";
import { SpendLedgerFileRefusedError } from "../../lib/spend-reservation-ledger";

type StorageRefusalLog = Pick<RequestLogContext, "localTerminalReason" | "terminalSource" | "errorCode">;

/** Local storage refusal, including retry wrappers: never provider-health evidence. */
export function mapSpendLedgerStorageError(error: unknown, logCtx?: StorageRefusalLog) {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof SpendLedgerFileRefusedError) {
      if (logCtx) {
        markLocalRequestLogRefusal(logCtx, SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE);
        logCtx.errorCode = SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE;
      }
      return {
        status: 503,
        errorType: "server_error",
        code: SPEND_LEDGER_STORAGE_UNAVAILABLE_CODE,
        message: error.message,
      } as const;
    }
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

export function spendLedgerStorageErrorResponse(error: unknown, logCtx?: StorageRefusalLog): Response | undefined {
  const refusal = mapSpendLedgerStorageError(error, logCtx);
  return refusal && formatErrorResponse(refusal.status, refusal.code, refusal.message);
}
