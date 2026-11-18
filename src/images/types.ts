import type { OcxProviderConfig } from "../types";
import type { VideoProviderAuth } from "./xai-video-client";

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

interface VideoBridgePlanBase {
  model: string;
  toolNames: Set<string>;
  /** Per-call xAI deadline (ms) for submit + poll. */
  timeoutMs?: number;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. ≤0 disables prune. */
  artifactsKeepCount?: number;
}

/**
 * Plan for the video bridge. A ready plan carries the one destination and credential the
 * bridge may use. An unavailable plan (an explicit `images.videoProvider` that cannot be used)
 * still claims the `video_gen` tool so each call is answered with the configuration error
 * instead of reaching any upstream; it carries no provider and no credential.
 */
export type VideoBridgePlan = VideoBridgePlanBase & (
  | { provider: OcxProviderConfig; auth: VideoProviderAuth; unavailable?: undefined }
  | { provider?: undefined; auth?: undefined; unavailable: string }
);

/** Result shape for video fulfillment — same as image. */
export type VideoCallResult = ImageCallResult;
