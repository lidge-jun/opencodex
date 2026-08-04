import type { OcxProviderConfig } from "../types";

export interface ImageBridgePlan {
  provider: OcxProviderConfig;
  auth: { baseUrl: string; token: string };
  model: string;
  toolNames: Set<string>;
  /** Per-call xAI deadline (ms). Defaults inside callXaiImages when omitted. */
  timeoutMs?: number;
  /** Defaults from the hosted image_generation tool when the model omits size/quality. */
  defaultSize?: string;
  defaultQuality?: string;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. ≤0 disables prune. */
  artifactsKeepCount?: number;
}

export interface ImageCallResult {
  ok: boolean;
  model: string;
  prompt: string;
  path?: string;
  files: string[];
  count: number;
  markdown?: string;
  error?: string;
}

/** Plan for the video bridge. Same auth/provider shape as image, without image-specific defaults. */
export interface VideoBridgePlan {
  provider: OcxProviderConfig;
  auth: { baseUrl: string; token: string };
  model: string;
  toolNames: Set<string>;
  /** Per-call xAI deadline (ms) for submit + poll. */
  timeoutMs?: number;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. ≤0 disables prune. */
  artifactsKeepCount?: number;
}

/** Result shape for video fulfillment — same as image. */
export type VideoCallResult = ImageCallResult;
