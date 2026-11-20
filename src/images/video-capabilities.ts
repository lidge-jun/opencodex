export interface VideoModelCapabilities {
  resolutions: readonly string[];
  aspectRatios: readonly string[];
  firstFrame: boolean;
  lastFrame: boolean;
  maxKeyframes: number;
  maxReferenceImages: number;
  referenceMaxResolution?: string;
  /** Whether a first frame may be combined with reference images (classic rejects the mix). */
  firstFrameWithReferences: boolean;
}

export const DEFAULT_VIDEO_MODEL = "grok-imagine-video-1.5-lite";
const legacyRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const wideRatios = [...legacyRatios, "21:9", "5:2"];

export function videoModelCapabilities(model?: string): VideoModelCapabilities {
  const full = ["grok-imagine-video-1.5", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-2026-05-30"].includes(model ?? "");
  const lite = model === "grok-imagine-video-1.5-lite";
  const classic = model === "grok-imagine-video";
  return {
    resolutions: full || lite ? ["480p", "720p", "1080p"] : ["480p", "720p"],
    aspectRatios: full || lite || classic ? wideRatios : legacyRatios,
    firstFrame: full || lite || classic,
    lastFrame: full,
    maxKeyframes: full ? 4 : 0,
    maxReferenceImages: full ? 14 : classic ? 7 : 0,
    ...(full ? { referenceMaxResolution: "720p" } : {}),
    firstFrameWithReferences: full,
  };
}
