import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  hardenConfigDir,
} from "../config";
import type { OcxConfig } from "../types";
import {
  normalizeNamedPublicUrl,
  type CloudflareTunnelMode,
  type CloudflareTunnelStartOptions,
} from "./cloudflare-tunnel";

export const CLOUDFLARE_TUNNEL_TOKEN_FILENAME = "cloudflare-tunnel-token";

export type CloudflareTunnelConfigurationSource = "environment" | "local" | "quick" | "none";

export interface ResolvedCloudflareTunnelSetup {
  mode: CloudflareTunnelMode;
  configured: boolean;
  source: CloudflareTunnelConfigurationSource;
  publicUrl: string | null;
  supportsSse: boolean;
  error?: "environment_incomplete" | "public_url_invalid" | "token_missing" | "token_mismatch";
  /** Internal fixed path. Never include it in an API response. */
  tokenFile?: string;
}

interface SetupIO {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  configDir?: string;
}

export interface StoredTunnelTokenChange {
  path: string;
  fingerprint: string;
  rollback(): void;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function storedCloudflareTunnelTokenPath(configDir = getConfigDir()): string {
  return join(configDir, CLOUDFLARE_TUNNEL_TOKEN_FILENAME);
}

/** Accept a raw Tunnel token or the install/run command copied from Cloudflare's dashboard. */
export function normalizeCloudflareTunnelToken(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 16_384 || /[\r\n]/.test(trimmed)) return null;
  const direct = /^eyJ[A-Za-z0-9._~+/=-]{30,16381}$/.test(trimmed) ? trimmed : null;
  if (direct) return direct;
  const candidates = trimmed.match(/eyJ[A-Za-z0-9._~+/=-]{30,16381}/g) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function replaceStoredCloudflareTunnelToken(
  input: unknown,
  configDir = getConfigDir(),
): StoredTunnelTokenChange {
  const token = normalizeCloudflareTunnelToken(input);
  if (!token) throw new Error("invalid Cloudflare Tunnel token");
  const path = storedCloudflareTunnelTokenPath(configDir);
  const hadPrevious = existsSync(path);
  const previous = hadPrevious ? readFileSync(path, "utf8") : null;

  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  hardenConfigDir(configDir);
  atomicWriteFile(path, `${token}\n`);

  return {
    path,
    fingerprint: tokenFingerprint(token),
    rollback() {
      if (previous !== null) atomicWriteFile(path, previous);
      else {
        try { unlinkSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
  };
}

export function resolveCloudflareTunnelSetup(
  config: Pick<OcxConfig, "cloudflareTunnel">,
  io: SetupIO = {},
): ResolvedCloudflareTunnelSetup {
  const env = io.env ?? process.env;
  const exists = io.exists ?? existsSync;
  const read = io.read ?? (path => readFileSync(path, "utf8"));
  const envToken = env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN?.trim();
  const envTokenFile = env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE?.trim();
  const envPublicUrl = env.OPENCODEX_CLOUDFLARE_PUBLIC_URL?.trim();
  const hasEnvironmentSetup = !!(envToken || envTokenFile || envPublicUrl);

  if (hasEnvironmentSetup) {
    const publicUrl = normalizeNamedPublicUrl(envPublicUrl);
    const hasOneTokenSource = !!envToken !== !!envTokenFile;
    const tokenFileExists = !envTokenFile || exists(envTokenFile);
    return {
      mode: "named",
      configured: hasOneTokenSource && tokenFileExists && !!publicUrl,
      source: "environment",
      publicUrl,
      supportsSse: true,
      ...(!publicUrl
        ? { error: envPublicUrl ? "public_url_invalid" as const : "environment_incomplete" as const }
        : !hasOneTokenSource || !tokenFileExists
          ? { error: "environment_incomplete" as const }
          : {}),
    };
  }

  const requestedMode = config.cloudflareTunnel?.mode ?? "named";
  if (requestedMode === "quick") {
    return { mode: "quick", configured: true, source: "quick", publicUrl: null, supportsSse: false };
  }

  const configuredValue = config.cloudflareTunnel?.publicUrl;
  const publicUrl = normalizeNamedPublicUrl(configuredValue);
  const path = storedCloudflareTunnelTokenPath(io.configDir ?? getConfigDir());
  if (!publicUrl) {
    return {
      mode: "named",
      configured: false,
      source: configuredValue || exists(path) ? "local" : "none",
      publicUrl: null,
      supportsSse: true,
      ...(configuredValue ? { error: "public_url_invalid" as const } : {}),
    };
  }
  if (!exists(path)) {
    return {
      mode: "named",
      configured: false,
      source: "local",
      publicUrl,
      supportsSse: true,
      error: "token_missing",
    };
  }
  let actualFingerprint: string;
  try {
    actualFingerprint = tokenFingerprint(normalizeCloudflareTunnelToken(read(path)) ?? "");
  } catch {
    return {
      mode: "named", configured: false, source: "local", publicUrl, supportsSse: true, error: "token_missing",
    };
  }
  if (!config.cloudflareTunnel?.tokenFingerprint || actualFingerprint !== config.cloudflareTunnel.tokenFingerprint) {
    return {
      mode: "named", configured: false, source: "local", publicUrl, supportsSse: true, error: "token_mismatch",
    };
  }
  return {
    mode: "named",
    configured: true,
    source: "local",
    publicUrl,
    supportsSse: true,
    tokenFile: path,
  };
}

export function cloudflareTunnelStartOverrides(
  setup: ResolvedCloudflareTunnelSetup,
): Pick<CloudflareTunnelStartOptions, "mode" | "namedTunnel"> {
  if (setup.mode === "quick") return { mode: "quick" };
  if (setup.source === "local" && setup.configured && setup.publicUrl && setup.tokenFile) {
    return {
      mode: "named",
      namedTunnel: { publicUrl: setup.publicUrl, tokenFile: setup.tokenFile },
    };
  }
  return { mode: "named" };
}
