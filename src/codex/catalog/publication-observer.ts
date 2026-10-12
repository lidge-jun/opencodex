import type { CatalogWriteIntent } from "./write-audit-contract";

export type CatalogPublicationEvent =
  | { readonly kind: "published"; readonly path: string; readonly intent: CatalogWriteIntent }
  | { readonly kind: "native-released"; readonly path: string | null };

const listeners = new Set<(event: CatalogPublicationEvent) => void>();

/** Process-local notifications; subscribers never own publication success. */
export function subscribeCatalogPublication(listener: (event: CatalogPublicationEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyCatalogPublication(event: CatalogPublicationEvent): void {
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* A subscriber cannot fail or undo publication. */ }
  }
}
