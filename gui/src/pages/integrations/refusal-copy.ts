import type { TKey } from "../../i18n/shared";
import { IntegrationApiError, type IntegrationRefusalEnvelope } from "./integration-api";
import { NativeApiError, type NativeRefusalEnvelope } from "./native-api";

/**
 * Envelopes the server sends that are NOT writer refusals.
 *
 * `integration_mutation_busy` is the common one: it carries no `reason`, so it
 * never becomes a refusal, and without this map the user saw the server's raw
 * English `error` string in every locale.
 */
const CODE_KEYS: Record<string, TKey> = {
  integration_mutation_busy: "integrations.error.busy",
};

/**
 * One place that turns a refusal into the sentence a user can act on.
 *
 * Every surface used to format its own, and each one dropped a different
 * field: the bulk flow lost `snapshotPath`, and nothing anywhere disclosed
 * `residual`. `residual` is the most important of the three — it means
 * compensation itself failed, so the file may be sitting in an intermediate
 * state and the user is the only one who can finish the recovery.
 */
export function refusalOf(error: unknown): IntegrationRefusalEnvelope | null {
  return error instanceof IntegrationApiError ? error.refusal : null;
}

function nativeRefusalOf(error: unknown): NativeRefusalEnvelope | null {
  return error instanceof NativeApiError ? error.refusal : null;
}

/** Keyed by `reason`, never by `state` (006 §5). */
function reasonKey(reason: string | undefined): TKey {
  if (reason === "conflict") return "integrations.error.conflict";
  if (reason === "unsafe") return "integrations.error.unsafe";
  if (reason === "non_loopback") return "integrations.error.nonLoopback";
  return "integrations.error.generic";
}

/**
 * Reasons whose localized copy REPLACES the server's message rather than
 * accompanying it.
 *
 * The writer always sends a non-empty English `message`, so anything that
 * merely falls back to a dictionary key never evaluates it. For most refusals
 * that is right — the message names the user's own file and we cannot say it
 * better. `non_loopback` is the exception: it is a fixed policy explanation
 * with no per-file detail, so a Korean or Japanese user was reading English
 * prose written for a server log.
 */
const LOCALIZED_REASONS: ReadonlySet<string> = new Set(["non_loopback"]);

export type Translate = (key: TKey, vars?: Record<string, string>) => string;

function describeNativeRefusal(
  t: Translate,
  refusal: NativeRefusalEnvelope,
  configPath?: string,
): string {
  if (refusal.reason === "orphaned_marker") {
    return t("integrations.native.error.orphanedMarker", { path: configPath ?? "" });
  }
  if (refusal.reason === "home_mismatch") {
    // The server message is the only place that carries both homes. Keep it
    // after the localized lead instead of flattening the useful conflict.
    return `${t("integrations.native.error.homeMismatch")} ${refusal.message}`;
  }
  if (refusal.reason === "not_installed") return t("integrations.native.error.notInstalled");
  if (refusal.reason === "config_busy") return t("integrations.native.error.configBusy");
  if (refusal.reason === "metadata_unreadable") return t("integrations.native.error.desktopUnsafeMetadata", { path: configPath ?? "" });
  if (refusal.reason === "cleanup_incomplete") {
    return t("integrations.native.error.desktopCleanupIncomplete", { paths: (refusal.residualPaths ?? []).join(", ") });
  }
  return refusal.message || t("integrations.error.generic");
}

export function describeRefusal(
  t: Translate,
  error: unknown,
  fallback?: string,
  nativeConfigPath?: string,
): string {
  const nativeRefusal = nativeRefusalOf(error);
  if (nativeRefusal) return describeNativeRefusal(t, nativeRefusal, nativeConfigPath);

  const refusal = refusalOf(error);
  if (!refusal) {
    const code = error instanceof IntegrationApiError ? String(error.body.code ?? "") : "";
    const known = CODE_KEYS[code];
    if (known) return t(known);
    return error instanceof Error && error.message
      ? error.message
      : fallback ?? t("integrations.error.generic");
  }
  const message = LOCALIZED_REASONS.has(refusal.reason)
    ? t(reasonKey(refusal.reason), { client: refusal.clientId })
    : refusal.message || t(reasonKey(refusal.reason));
  if (refusal.snapshotPath) {
    // A dead end the user cannot finish by hand is worse than no rollback at
    // all, so the path rides along whenever the server sent one.
    return t(
      refusal.residual ? "integrations.error.residual" : "integrations.error.recover",
      { message, path: refusal.snapshotPath },
    );
  }
  return refusal.reason === "conflict" || refusal.reason === "unsafe"
    ? `${t(reasonKey(refusal.reason))} ${message}`
    : message;
}
