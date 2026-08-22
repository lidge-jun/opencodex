import { createHttpCoordinator } from "./http";
import type { FetchImplementation, ForkSyncCoordinator } from "../types";

export interface CursorWebhookOptions {
  url?: string;
  secret?: string;
  fetchImpl?: FetchImplementation;
}

export function createCursorWebhookCoordinator(
  options: CursorWebhookOptions,
): ForkSyncCoordinator {
  const http = createHttpCoordinator({
    ...options,
    signatureHeader: "x-fork-sync-signature",
    signaturePrefix: "sha256=",
    errorLabel: "Cursor webhook",
  });
  return {
    id: "cursor-webhook",
    async start(event) {
      if (!options.secret) return;
      await http.start(event);
    },
  };
}
