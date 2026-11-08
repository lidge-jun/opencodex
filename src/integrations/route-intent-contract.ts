import type { ExportModel } from "../clients/config-export";
import type { HomeRouteIntentDocument, RouteClientId, RouteClientIntent, RouteClientOutcome } from "../link/route-intent";
import type { OcxConfig } from "../types";
import type { IntegrationStateStore } from "./store";

export type { RouteClientOutcome } from "../link/route-intent";

export interface RouteIntentReceipt {
  version: 1;
  linkId?: string;
  /** Last local served roster, retained for offline owned-conflict recovery. No credentials. */
  models?: readonly ExportModel[];
  document: HomeRouteIntentDocument;
  clients: Record<RouteClientId, RouteClientIntent>;
  sources: Record<RouteClientId, "builtin" | "default" | "device" | "native" | "local">;
  selectedClients: RouteClientId[];
  outcomes: RouteClientOutcome[];
  /** Null if any client failed, conflicts, or is not installed. Never a partial success. */
  appliedRouteIntentDigest: string | null;
  appliedAt: string;
  /** Off intents are proved, while enabled clients await the local served model roster. */
  catalogPending?: true;
}

export interface RouteIntentApplyInput {
  config: OcxConfig;
  linkId?: string;
  document: HomeRouteIntentDocument;
  /** The local served roster, never Home-generated client contributions. */
  models: readonly ExportModel[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  store?: IntegrationStateStore;
  /** Isolates local opt-outs and receipts; defaults to the local config directory. */
  statePath?: string;
  /** Home passes an empty list; undefined reads this Child's persistent local opt-outs. */
  localOff?: readonly RouteClientId[];
  overwriteConflict?: boolean;
  /** When a client toggle grants takeover, other clients retain ordinary conflict checks. */
  overwriteClient?: RouteClientId;
  /** Rechecks connection/runtime ownership immediately before each writer commits. */
  beforeWrite?: () => void;
  /** Reconcile only explicit local opt-outs when no Home document is available. */
  onlyClients?: readonly RouteClientId[];
  /** Clients skipped by onlyClients keep the previous receipt outcome for the same client intent. */
  retainSkippedOutcomes?: boolean;
  /** Explicit disconnect recovery only: snapshot an owned conflicting block, then remove it. */
  recoverConflicts?: boolean;
  /** Lifecycle exclusion around async file writers; native adapters manage their own lock order. */
  withFileWrites?: <T>(work: () => Promise<T>) => Promise<T>;
  withReceiptWrite?: (write: () => void) => void;
  now?: () => Date;
  /** Native adapters retain their existing ownership/journal implementations. */
  applyNative?: (client: "codex" | "claude" | "claude-desktop" | "grok", intent: RouteClientIntent) => Promise<RouteClientOutcome>;
}
