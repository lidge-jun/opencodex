import type { OcxProviderConfig } from "../types";

export interface ImageBridgePlan {
  provider: OcxProviderConfig;
  auth: { baseUrl: string; token: string };
  model: string;
  toolNames: Set<string>;
  /** Max artifact files to retain (from config.images.artifactsKeepCount). Default 200. */
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
