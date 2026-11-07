declare const verifiedRoot: unique symbol;

/** In-process module-owned root handle; parsing a document does not create one. */
export interface VerifiedRoot { readonly [verifiedRoot]: never }

export function bootstrapEmbeddedRoot(bytes: Uint8Array, nowMs: number): VerifiedRoot;
