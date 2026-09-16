import type { PlatformCapabilities, SocialPlatform } from "./types";

export const SOCIAL_PUBLISHING_ENABLED_ENV = "SOCIAL_PUBLISHING_ENABLED";
export const OPENPOST_BASE_URL_ENV = "OPENPOST_BASE_URL";
export const OPENPOST_API_TOKEN_ENV = "OPENPOST_API_TOKEN";
export const OPENPOST_TRANSPORT_ENV = "OPENPOST_TRANSPORT";
export const PAO_SOCIAL_DB_PATH_ENV = "PAO_SOCIAL_DB_PATH";

export const DEFAULT_OPENPOST_BASE_URL = "http://localhost:8080";
export const DEFAULT_OPENPOST_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

export const RETRY_BACKOFF_SECONDS = [15, 60, 300, 1200, 3600];

export const PLATFORM_DEFAULTS: Record<SocialPlatform, PlatformCapabilities> = {
  x: {
    platform: "x",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 280, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 4, max_bytes: 5 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 512 * 1024 * 1024, max_duration_ms: 140_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  mastodon: {
    platform: "mastodon",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 500, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 4, max_bytes: 16 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 40 * 1024 * 1024, max_duration_ms: 300_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  bluesky: {
    platform: "bluesky",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 300, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 4, max_bytes: 1_000_000 },
      video: { allowed: true, max_bytes: 50 * 1024 * 1024, max_duration_ms: 60_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  linkedin: {
    platform: "linkedin",
    formats: ["text", "single_image", "multi_image", "video", "article"],
    text: { max_length: 3000, title: true, caption: true, description: true },
    media: {
      image: { allowed: true, max_count: 9, max_bytes: 10 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 200 * 1024 * 1024, max_duration_ms: 600_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  threads: {
    platform: "threads",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 500, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 10, max_bytes: 8 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 1024 * 1024 * 1024, max_duration_ms: 300_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  facebook: {
    platform: "facebook",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 5000, title: true, caption: true, description: true },
    media: {
      image: { allowed: true, max_count: 10, max_bytes: 10 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 1024 * 1024 * 1024, max_duration_ms: 1200_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  instagram: {
    platform: "instagram",
    formats: ["single_image", "multi_image", "video", "reel"],
    text: { max_length: 2200, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 10, max_bytes: 8 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 1024 * 1024 * 1024, max_duration_ms: 900_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  tiktok: {
    platform: "tiktok",
    formats: ["video"],
    text: { max_length: 2200, title: true, caption: true, description: false },
    media: {
      image: { allowed: false },
      video: { allowed: true, max_bytes: 512 * 1024 * 1024, max_duration_ms: 600_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  youtube: {
    platform: "youtube",
    formats: ["video", "short"],
    text: { max_length: 5000, title: true, caption: true, description: true },
    media: {
      image: { allowed: false },
      video: { allowed: true, max_bytes: 2048 * 1024 * 1024, max_duration_ms: 3600_000 },
    },
    scheduling: { supported: true },
    review: { provider_review_required: false },
  },
  discord: {
    platform: "discord",
    formats: ["text", "single_image", "multi_image", "video"],
    text: { max_length: 2000, title: false, caption: true, description: false },
    media: {
      image: { allowed: true, max_count: 10, max_bytes: 25 * 1024 * 1024 },
      video: { allowed: true, max_bytes: 25 * 1024 * 1024, max_duration_ms: 300_000 },
    },
    scheduling: { supported: false },
    review: { provider_review_required: false },
  },
};

