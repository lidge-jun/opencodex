import { SOCIAL_PUBLISHING_ENABLED_ENV } from "./constants";

export function isSocialPublishingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[SOCIAL_PUBLISHING_ENABLED_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

