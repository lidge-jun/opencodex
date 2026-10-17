export const CLOUD_HOST = "codex-cloud-backend.chatgpt.com";
export const CLOUD_NETWORK_PROTOCOL = 1;
export const CLOUD_HELPER_LABEL = "com.opencodex.cloud-network";
export const CLOUD_HELPER_ROOT = "/Library/Application Support/OpenCodex/cloud-network";
export const CLOUD_HELPER_SOCKET = "/var/run/com.opencodex.cloud-network.sock";
export const CLOUD_HELPER_PLIST = "/Library/LaunchDaemons/com.opencodex.cloud-network.plist";

export type CloudMappingState = "idle" | "active" | "recovery_required";
export interface CloudHelperReply {
  protocol: number;
  ok: boolean;
  state: CloudMappingState;
  error?: string;
}

export interface CloudNetworkStatus {
  configured: boolean;
  state: "disabled" | "starting" | "active" | "unavailable" | "stopped";
  reason?: string;
  applicationHandshake: "unverified";
}

export class CloudNetworkError extends Error {
  constructor(message: string, readonly recoveryRequired = false) { super(message); }

  static fromReply(reply: CloudHelperReply, fallback: string): CloudNetworkError {
    return new CloudNetworkError(reply.error ?? fallback, reply.state === "recovery_required");
  }
}
