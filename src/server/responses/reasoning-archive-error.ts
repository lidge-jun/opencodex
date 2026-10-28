import { formatErrorResponse } from "../../bridge";
import { ReasoningArchiveBusyError, ReasoningArchiveError,
  ReasoningArchiveQuotaError } from "../../responses/reasoning-retention";

/** Local storage refusal before any send. Never expose filesystem messages or causes. */
export function reasoningArchiveErrorResponse(error: unknown): Response | undefined {
  let code: string;
  let message: string;
  if (error instanceof ReasoningArchiveQuotaError) {
    code = "reasoning_archive_quota_exceeded";
    message = "Local reasoning archive is full. Review and manually remove older reasoning archives, then retry the unchanged request.";
  } else if (error instanceof ReasoningArchiveBusyError) {
    code = "reasoning_archive_busy";
    message = "Another local reasoning archive writer is active. Wait for it to finish, then retry the unchanged request.";
  } else if (error instanceof ReasoningArchiveError) {
    code = "reasoning_archive_unavailable";
    message = "Local reasoning archive is unavailable. Check archive directory permissions and local storage health before retrying the unchanged request.";
  } else return undefined;
  // Match the local spend-ledger storage refusal's 503 convention without guessing a delay.
  return formatErrorResponse(503, "server_error", message, { code, classified: true });
}
