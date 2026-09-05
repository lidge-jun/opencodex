import type { OcxConfig } from "../../types";
import { isEffectiveCodexDesktopAuthless } from "../loopback-target";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "./account-models";
import { NATIVE_RESERVE_MODEL } from "./native-models";
import type { RawEntry } from "./parsing";

export const RESERVE_METADATA_SOURCE_FIELD = "opencodex_reserve_metadata_source";
/** Validated genuine source metadata on the existing catalog, never an authorization. */
export const RESERVE_SOURCE_CATALOG_FIELD = "opencodex_reserve_source";
export const RESERVE_LUNA_METADATA_SOURCE = "gpt-5.6-luna";

/** Metadata only: no process-local availability or credential state belongs in a catalog. */
export interface ReserveCatalogProjection {
  readonly source: RawEntry;
  readonly mainSelectors: readonly string[];
}

/** The caller supplies a validated actual observation and an already context-capped Luna pin. */
export function createReserveCatalogProjection(
  config: Pick<OcxConfig, "runtimeRole" | "hostname" | "unauthenticatedLoopbackListener" | "codexDesktopAuthless">,
  mainSelectors: readonly string[],
  observedSource: RawEntry | null,
  lunaSource: RawEntry | null,
): ReserveCatalogProjection | undefined {
  if (!isEffectiveCodexDesktopAuthless(config) || mainSelectors.length === 0) return undefined;
  const original = observedSource ?? lunaSource;
  if (!original) return undefined;
  const source = structuredClone(original);
  source.slug = NATIVE_RESERVE_MODEL;
  source.display_name = observedSource?.display_name ?? "Luna Reserve";
  source.description = "Manual main-account Reserve through OpenCodex; recent upstream permission is required for every request.";
  // This qualified OCX endpoint accepts the selector, not an OpenAI API-key model grant.
  source.supported_in_api = true;
  source[RESERVE_METADATA_SOURCE_FIELD] = observedSource ? NATIVE_RESERVE_MODEL : RESERVE_LUNA_METADATA_SOURCE;
  delete source.available_in_plans;
  delete source.availability_nux;
  delete source.upgrade;
  delete source.opencodex_account_observed_native;
  delete source.opencodex_account_observed_selectors;
  return { source, mainSelectors: [...mainSelectors] };
}

/** Exact OCX account projection, never another provider's similarly named model. */
export function isReserveCatalogProjection(entry: RawEntry): boolean {
  return entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND
    && typeof entry.slug === "string"
    && entry.slug.indexOf("/") > 0
    && entry.slug.indexOf("/") === entry.slug.lastIndexOf("/")
    && entry.slug.endsWith(`/${NATIVE_RESERVE_MODEL}`)
    && (entry[RESERVE_METADATA_SOURCE_FIELD] === NATIVE_RESERVE_MODEL
      || entry[RESERVE_METADATA_SOURCE_FIELD] === RESERVE_LUNA_METADATA_SOURCE);
}
