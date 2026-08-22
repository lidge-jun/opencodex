import { createHmac } from "node:crypto";
import type { FetchImplementation, ForkSyncCoordinator } from "../types";

export interface HttpCoordinatorOptions {
  url?: string;
  secret?: string;
  signatureHeader?: string;
  signaturePrefix?: string;
  authHeader?: string;
  errorLabel?: string;
  fetchImpl?: FetchImplementation;
}

export function createHttpCoordinator(
  options: HttpCoordinatorOptions,
): ForkSyncCoordinator {
  return {
    id: "http",
    async start(event) {
      if (event.kind !== "pin-updated" || !options.url) return;

      const body = JSON.stringify(event);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.authHeader) headers.authorization = options.authHeader;
      if (options.secret) {
        const signature = createHmac("sha256", options.secret)
          .update(body)
          .digest("hex");
        headers[options.signatureHeader ?? "x-fork-sync-signature"] =
          `${options.signaturePrefix ?? "sha256="}${signature}`;
      }

      const response = await (options.fetchImpl ?? fetch)(options.url, {
        method: "POST",
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(
          `${options.errorLabel ?? "HTTP coordinator"} returned HTTP ${response.status}`,
        );
      }
    },
  };
}
