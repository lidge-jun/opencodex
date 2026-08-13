import { LAB_CREDENTIAL_LEASE, type LabCredentialLeaseV1, type LabDestinationV1 } from "./types";

export class LabCredentialError extends Error {
  override readonly name = "LabCredentialError";
  constructor(message: string, readonly code: "harness_failure" | "budget_exhausted") { super(message); }
}

interface LeaseState { destinationFingerprint: string; transportId: string; remaining: number }
const LEASE_STATE = new WeakMap<object, LeaseState>();
type InternalLease = LabCredentialLeaseV1 & { toJSON(): never };

export interface CreateLeaseOptions {
  destination: LabDestinationV1;
  transportId?: string;
  budget?: number;
}

/** Trusted credential owner may associate secret state with this opaque capability outside Lab. */
export function createCredentialLease(opts: CreateLeaseOptions): LabCredentialLeaseV1 {
  const budget = opts.budget ?? 1;
  if (!Number.isInteger(budget) || budget <= 0) throw new LabCredentialError("invalid credential lease budget", "harness_failure");
  let lease!: InternalLease;
  lease = {
    [LAB_CREDENTIAL_LEASE]: true,
    get remainingRequests(): number { return LEASE_STATE.get(lease)?.remaining ?? 0; },
    consume(): void {
      const state = LEASE_STATE.get(lease);
      if (!state) throw new LabCredentialError("unknown credential lease", "harness_failure");
      if (state.remaining <= 0) throw new LabCredentialError("credential lease exhausted", "budget_exhausted");
      state.remaining -= 1;
    },
    toJSON(): never { throw new LabCredentialError("credential lease is non-serializable", "harness_failure"); },
  };
  LEASE_STATE.set(lease, {
    destinationFingerprint: opts.destination.fingerprint,
    transportId: opts.transportId ?? "default",
    remaining: budget,
  });
  return Object.freeze(lease);
}

export function isCredentialLease(value: unknown): value is LabCredentialLeaseV1 {
  return typeof value === "object" && value !== null && LEASE_STATE.has(value as object)
    && (value as LabCredentialLeaseV1)[LAB_CREDENTIAL_LEASE] === true;
}

export function assertLeaseScope(lease: LabCredentialLeaseV1, destination: LabDestinationV1, transportId = "default"): void {
  const state = LEASE_STATE.get(lease as object);
  if (!state) throw new LabCredentialError("unknown credential lease", "harness_failure");
  if (state.destinationFingerprint !== destination.fingerprint || state.transportId !== transportId) {
    throw new LabCredentialError("credential lease scope mismatch", "harness_failure");
  }
}
