import { z } from "zod";

/** Wire-level error codes shared by Bridge.* contracts. */
export const BRIDGE_ERROR_CODES = [
  "BINDING_CHANGED",
  "BINDING_REVISION_CONFLICT",
  "OPERATION_ID_CONFLICT",
  "AUTH_REQUIRED",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_REVOKED",
  "TARGET_ACTIVE",
  "TARGET_NOT_FOUND",
  "BINDING_NOT_FOUND",
  "BINDING_EXISTS",
  "HOST_OFFLINE",
  "ATTACHMENT_UNAVAILABLE",
  "ATTACHMENT_REQUIRED",
  "DELIVERY_UNKNOWN",
  "SEND_IN_PROGRESS",
  "SEND_PAUSED",
  "DUPLICATE_PROMPT",
  "EMPTY_PROMPT",
  "PROMPT_TOO_LARGE",
  "INVALID_CHATGPT_URL",
  "INVALID_REGISTRY",
  "PROTOCOL_UNSUPPORTED",
  "CONTEXT_INCOMPATIBLE",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export class BridgeCoreError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "BridgeCoreError";
    this.code = code;
    this.details = details;
  }
}

/** Definite non-delivery outcomes: the send provably never reached the chat. */
export const DEFINITE_NON_DELIVERY_CODES: readonly BridgeErrorCode[] = [
  "EMPTY_PROMPT",
  "SEND_PAUSED",
  "TARGET_ACTIVE",
  "PROMPT_TOO_LARGE",
  "INVALID_CHATGPT_URL",
  "CAPABILITY_EXPIRED",
  "CAPABILITY_REVOKED",
  "ATTACHMENT_REQUIRED",
];

export const CHATGPT_CONVERSATION_URL_PATTERN =
  /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseChatGptConversationUrl(url: string): { conversationId: string; canonicalUrl: string } {
  const trimmed = url.trim().replace(/[#?].*$/, "");
  if (!CHATGPT_CONVERSATION_URL_PATTERN.test(trimmed)) {
    throw new BridgeCoreError("INVALID_CHATGPT_URL", `Not a normal ChatGPT conversation URL: ${url}`);
  }
  const conversationId = trimmed.split("/").pop()!.toLowerCase();
  return { conversationId, canonicalUrl: `https://chatgpt.com/c/${conversationId}` };
}

export const HOST_KINDS = ["codex", "dsh"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export const LIFECYCLES = ["active", "paused", "revoked", "unbound"] as const;
export type BridgeLifecycle = (typeof LIFECYCLES)[number];

export const ATTACHMENT_STATES = ["pending", "attached", "readable"] as const;
export type BridgeAttachmentState = (typeof ATTACHMENT_STATES)[number];

export const DELIVERY_STATES = ["reserved", "delivered", "not-delivered", "unknown"] as const;
export type BridgeDeliveryState = (typeof DELIVERY_STATES)[number];

export const hostRefSchema = z.object({
  kind: z.enum(HOST_KINDS),
  /** Durable host instance id; never a PID, port, or tab handle. */
  instanceId: z.string().min(1),
  /** Exact Codex task id / DSH session id. */
  targetId: z.string().min(1),
  /** Verified workspace identity; never a model-reported path. */
  workspaceRef: z.string().min(1),
});

export const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  bindingId: z.string().uuid(),
  ownerRef: z.string().min(1),
  host: hostRefSchema,
  chat: z.object({
    conversationId: z.string().min(1),
    canonicalUrl: z.string().regex(CHATGPT_CONVERSATION_URL_PATTERN),
    kind: z.literal("normal-chat"),
  }),
  source: z.object({
    kind: z.enum(["legacy-codex", "bridge-v1"]),
    locator: z.string().min(1),
  }),
  revision: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  lifecycle: z.enum(LIFECYCLES),
  attachmentState: z.enum(ATTACHMENT_STATES),
  /** sha256 of the controller capability; plaintext never stored here. */
  capabilityHash: z.string().nullable().default(null),
  capabilityExpiresAt: z.string().nullable().default(null),
  proof: z
    .object({
      attachment: z.string().nullable().default(null),
      hostRead: z.string().nullable().default(null),
      chatRead: z.string().nullable().default(null),
      checkedAt: z.string().nullable().default(null),
    })
    .default(() => ({ attachment: null, hostRead: null, chatRead: null, checkedAt: null })),
  lastReceiptId: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BridgeBinding = z.infer<typeof bindingSchema>;

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Largest prompt a delivery may carry; the ceiling the Codex host sends at. */
export const MAX_PROMPT_CHARS = 512 * 1024;

/** Management actions accepted by the unified manage entry point. */
export const MANAGEMENT_ACTIONS = [
  "create",
  "attach",
  "pause",
  "resume",
  "renew",
  "revoke",
  "unbind",
] as const;
export type BridgeManagementAction = (typeof MANAGEMENT_ACTIONS)[number];

export interface OperationReceipt {
  operationId: string;
  bindingId: string;
  action: BridgeManagementAction;
  revision: number;
  outcome: "applied" | "alreadyApplied";
  errorCode?: BridgeErrorCode;
  createdAt: string;
}
