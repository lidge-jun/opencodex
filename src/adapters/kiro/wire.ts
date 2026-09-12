import type { OcxProviderConfig } from "../../types";
import type { KiroImage } from "../kiro-images";

export const AMZ_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";
export const SDK_VERSION = "1.0.27";
export const NODE_VERSION = "22.21.1";
export const KIRO_IDE_VERSION = "1.0.0";
export const KIRO_FALLBACK_SERIALIZATION_ENVELOPE_BYTES = 64 * 1024;
export type KiroWireClient = "ide" | "cli";

export function kiroCliPlatform(): "linux" | "macos" | "windows" {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

export function kiroCliUserAgent(includeAppVersion: boolean): string {
  return [
    "aws-sdk-rust/1.3.15",
    "ua/2.1",
    "api/codewhispererstreaming/0.1.17975",
    `os/${kiroCliPlatform()}`,
    "lang/rust/1.92.0",
    ...(includeAppVersion ? ["md/appVersion-2.14.2"] : []),
    "m/F",
    "app/AmazonQ-For-CLI",
  ].join(" ");
}

// Payload construction (conversationState)
export interface KiroToolUse {
  name: string;
  input: Record<string, unknown>; // OBJECT, not stringified
  toolUseId: string;
}
export interface KiroToolResult {
  content: Array<{ text: string }>;
  status: string;
  toolUseId: string;
}
export interface KiroUserInputMessage {
  content: string;
  modelId?: string;
  origin?: string;
  userInputMessageContext?: {
    tools?: unknown[];
    toolResults?: KiroToolResult[];
  };
  images?: KiroImage[];
}
export interface KiroHistoryEntry {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: {
    content: string;
    toolUses?: KiroToolUse[];
    reasoningContent?: { redactedContent: string };
  };
}

export function kiroToolWireNames(tools: readonly unknown[]): string[] {
  return tools
    .map(tool => {
      const spec = (tool as { toolSpecification?: { name?: unknown } }).toolSpecification;
      return typeof spec?.name === "string" ? spec.name : undefined;
    })
    .filter((name): name is string => typeof name === "string");
}

export function kiroRuntimeEndpoint(provider: OcxProviderConfig, region: string): string {
  const configured = new URL(provider.baseUrl);
  if (
    /^runtime\.[a-z]{2}(?:-[a-z]+)+-\d\.kiro\.dev$/i.test(configured.hostname)
    && configured.pathname === "/"
  ) {
    return `https://runtime.${region}.kiro.dev/`;
  }
  return configured.toString();
}
