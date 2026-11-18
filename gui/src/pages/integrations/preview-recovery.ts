import { isIntegrationPreviewUnavailable } from "./integration-api";

/**
 * What a preview that answered 409 `integration_preview_unavailable` means, and the one
 * action that can honestly fix it.
 *
 * The server refuses rather than gathering, because a preview that discovered models would
 * refresh credentials and write the provider cache — a write wearing a read's name. The
 * retained roster is filled by an ORDINARY load instead. On the dashboard that load is the
 * same collection read the Integrations page already performs on mount, so the recovery is
 * "read the page's own data again, then plan": no new write path, and the preview stays a
 * read.
 *
 * `null` means the error is not this refusal, so the caller should surface its ordinary
 * failure copy.
 */
export type PreviewRecovery = "catalog-unavailable";

export function previewRecoveryFor(error: unknown): PreviewRecovery | null {
  return isIntegrationPreviewUnavailable(error) ? "catalog-unavailable" : null;
}
