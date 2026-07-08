/**
 * Runtime-controllable debug flags.
 * Provider debug: `ocx debug provider on|off|status|reset|logs [-f]` (or OCX_DEBUG=1 on start).
 * Usage capture: `ocx debug usage on|off|status|reset|logs [-f]` (or OPENCODEX_USAGE_DEBUG=1).
 * `/api/debug` and `ocx debug` override env defaults without restart.
 */

export const DEBUG_ENV = {
  debug: "OCX_DEBUG",
  usage: "OPENCODEX_USAGE_DEBUG",
} as const;

/** Legacy env var that still enables provider debug logging. */
const LEGACY_DEBUG_ENV = ["OCX_DEBUG_FRAMES"] as const;

export type DebugFlag = keyof typeof DEBUG_ENV;

export interface DebugSettingsView {
  enabled: boolean;
  usage: boolean;
  runtimeOverride: Partial<Record<DebugFlag, boolean>>;
  env: Record<DebugFlag, boolean>;
}

const runtimeOverride: Partial<Record<DebugFlag, boolean>> = {};

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function legacyDebugEnvEnabled(): boolean {
  return LEGACY_DEBUG_ENV.some(name => envFlag(name));
}

export function isDebugEnabled(): boolean {
  if (runtimeOverride.debug !== undefined) return runtimeOverride.debug;
  return envFlag(DEBUG_ENV.debug) || legacyDebugEnvEnabled();
}

/** @deprecated Use isDebugEnabled(). */
export function isFramesDebugEnabled(): boolean {
  return isDebugEnabled();
}

export function isUsageDebugEnabled(): boolean {
  if (runtimeOverride.usage !== undefined) return runtimeOverride.usage;
  return envFlag(DEBUG_ENV.usage);
}

export function getDebugSettings(): DebugSettingsView {
  return {
    enabled: isDebugEnabled(),
    usage: isUsageDebugEnabled(),
    runtimeOverride: { ...runtimeOverride },
    env: {
      debug: envFlag(DEBUG_ENV.debug) || legacyDebugEnvEnabled(),
      usage: envFlag(DEBUG_ENV.usage),
    },
  };
}

export function setDebugSettings(partial: Partial<Record<DebugFlag, boolean>>): DebugSettingsView {
  for (const key of ["debug", "usage"] as const) {
    if (partial[key] !== undefined) runtimeOverride[key] = partial[key];
  }
  return getDebugSettings();
}

export function clearDebugSetting(flag: DebugFlag): DebugSettingsView {
  delete runtimeOverride[flag];
  return getDebugSettings();
}

export function clearDebugSettings(): DebugSettingsView {
  for (const key of ["debug", "usage"] as const) {
    delete runtimeOverride[key];
  }
  return getDebugSettings();
}

/** Test isolation: drop runtime overrides only (env vars untouched). */
export function resetDebugSettingsForTests(): void {
  clearDebugSettings();
}
