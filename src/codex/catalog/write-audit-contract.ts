/** Bottom-layer metadata contract: neither K nor the filesystem adapter owns intent. */
export type CatalogWriteIntent = "refresh" | "cache" | "pull" | "restore";
export type CatalogAuditConfigSource = "file" | "default" | "fallback" | "unreadable";
export type CatalogAuditRefusalReason = "foreign-owner" | "owner-unknown"
  | "unbacked-routed-removal" | "unbacked-routed-clear";

export interface CatalogWriteAuditDetails {
  readonly target: "catalog" | "cache";
  readonly outcome: "written" | "refused";
  readonly reason?: CatalogAuditRefusalReason;
  readonly routedBefore?: number | null;
  readonly routedAfter?: number | null;
  readonly configSource?: CatalogAuditConfigSource;
}

export interface CatalogWriteAuditEvent extends CatalogWriteAuditDetails {
  readonly intent: CatalogWriteIntent;
  readonly writer: string;
  /** Supplied by K, never discovered by the adapter. */
  readonly opencodexHome: string;
}
