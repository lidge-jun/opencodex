import { createHmac, randomBytes } from "node:crypto";
import type { OcxConfig } from "../../types";
import { hasForwardableCodexBearer, type DataPlaneAdmission } from "../../server/auth-cors";

const key = randomBytes(32);

/** Bind Muse continuations to the caller's existing bearer without exposing it or treating it as an OpenCodex key. */
export function museCodexPrincipal(headers: Headers, config: OcxConfig, admission: DataPlaneAdmission | undefined): string | undefined {
  if (admission?.kind !== "loopback" || !hasForwardableCodexBearer(headers, config)) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "");
  if (!match || match[1]!.length < 32 || match[1]!.length > 16384) return undefined;
  return createHmac("sha256", key).update("opencodex.muse.codex-bearer.v1\0").update(match[1]!).digest("hex");
}
