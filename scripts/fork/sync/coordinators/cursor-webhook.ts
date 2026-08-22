import { createHmac } from "node:crypto";
import type { FetchImplementation, ForkSyncCoordinator } from "../types";

export interface CursorWebhookOptions {
  url?: string;
  secret?: string;
  fetchImpl?: FetchImplementation;
}

export function createCursorWebhookCoordinator(
  options: CursorWebhookOptions,
): ForkSyncCoordinator {
  return {
    id: "cursor-webhook",
    async start(event) {
      if (event.kind !== "pin-updated" || !options.url || !options.secret) return;
      const body = JSON.stringify(event);
      const signature = createHmac("sha256", options.secret)
        .update(body)
        .digest("hex");
      const response = await (options.fetchImpl ?? fetch)(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fork-sync-signature": `sha256=${signature}`,
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`Cursor webhook returned HTTP ${response.status}`);
      }
    },
  };
}
