import { createHmac, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { MuseMspError } from "./connection";

const KEY = randomBytes(32);
const ENV_KEYS = new Set(["PATH", "SYSTEMROOT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "TEMP", "TMP", "TBH_CREDENTIAL_BACKEND", "TBH_DISABLE_TELEMETRY", "TBH_DISABLE_FEATURE_CONFIG", "MUSE_EXPERIMENTAL_SDK_ENABLED"]);

/**
 * Process-local route binding for a shared native runner. The environment is the
 * restricted base used to construct child settings, never process.env. The caller
 * must change profileRevision when provisioning behavior changes. This key does
 * not identify a Muse account and must not be used as a quota account ID.
 */
export function museNativeRouteKey(input: { providerId: string; profileRevision: string; executable: string; cwd: string; args: readonly string[]; env: NodeJS.ProcessEnv }): string {
  const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096;
  if (!bounded(input.providerId) || !bounded(input.profileRevision) || !bounded(input.executable) || !isAbsolute(input.executable) || !bounded(input.cwd) || !isAbsolute(input.cwd) ||
      !Array.isArray(input.args) || input.args.length > 64 || input.args.some(value => !bounded(value)) || !input.env || typeof input.env !== "object") {
    throw new MuseMspError("invalid_native_route");
  }
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(input.env)) {
    const key = name.toUpperCase();
    if (!ENV_KEYS.has(key) || env.has(key) || (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > 32768))) throw new MuseMspError("invalid_native_environment");
    if (value !== undefined) env.set(key, value);
  }
  const material = JSON.stringify([input.providerId, input.profileRevision, input.executable, input.cwd, input.args, [...env.entries()].sort(([a], [b]) => a.localeCompare(b))]);
  return createHmac("sha256", KEY).update("opencodex.muse-native-route.v1\0").update(material).digest("hex");
}
