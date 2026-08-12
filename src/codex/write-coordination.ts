/**
 * The witness a native Codex write is coordinated by.
 *
 * NOT an `AdmissionSnapshot`, and the difference is the whole reason this file
 * exists. `admitCodexWrite` refuses before it constructs a snapshot unless
 * ownership is `owned` (`admission.ts`), so every snapshot it produces carries
 * `owned` — the field cannot hold `unknown` at all. Reusing that type here would
 * have meant one of two untruths: either the call becomes gated on ownership,
 * which refuses Codex injection on every Windows machine and on Linux without a
 * reachable user bus, or a hand-built snapshot claims an admission that never
 * happened.
 *
 * So this type authorizes THE WRITE, not the DECISION to write. Deciding whether
 * a write should happen at all is admission's job and belongs to its own phase,
 * behind the Windows definition-chain walk.
 *
 * What the id covers, and why it is the OUTPUT rather than the inputs: the bytes
 * `injectCodexConfig` emits depend on the port, the resolved catalog path, the
 * hostname, websocket mode, legacy mode and the managed sub-agent defaults. An
 * enumeration of those was already incomplete once. Hashing the computed
 * candidate bytes closes the class instead of the instance — an input that
 * changes the output changes the id whether or not anyone remembered to list it.
 */
import { createHash } from "node:crypto";

export interface CodexWriteCandidate {
  /** The exact string about to replace `config.toml`. */
  readonly configBytes: string;
  /** The exact string about to replace the profile. */
  readonly profileBytes: string;
  /** The RESOLVED catalog path, never the raw option. */
  readonly catalogPath: string | null;
}

export interface CodexWriteEvidence {
  /** sha256 of the `config.toml` bytes this operation read as its input. */
  readonly nativeInputIdentity: string;
  /** Digest of the persisted OpenCodex config these bytes were derived from. */
  readonly persistedIdentity: string;
  /** Generation as observed before the lock; `present:false` means no coordinator yet. */
  readonly generation: Readonly<{ present: boolean; value: number }>;
  /** Content identity of the journal, or a stable marker for absence. */
  readonly journalIdentity: string;
  readonly canonicalTargets: Readonly<{
    config: string;
    profile: string;
    journal: string;
  }>;
}

export interface CodexWriteCoordination {
  readonly candidate: CodexWriteCandidate;
  readonly evidence: CodexWriteEvidence;
  /**
   * Recorded context, deliberately OUTSIDE `comparisonId`.
   *
   * The lock compares one id and nothing else, so a field that is copied rather
   * than re-observed detects no drift by being in it — it would only match
   * itself. Ownership is not re-observed under the lock (that would mean running
   * a service-manager subprocess while N and C are held), so it travels as
   * something the operation SAW, not as something the comparison PROVES.
   */
  readonly observedOwnership: "owned" | "foreign" | "unknown";
  readonly comparisonId: string;
}

/**
 * Collapse a generation to one token.
 *
 * Absent and present-zero are the same authority — no cooperating write has
 * committed — and they cannot be observed the same way: before the lock only
 * absence is visible, and inside it only the committed zero is. Without this
 * they never match and every first write refuses.
 */
function generationToken(generation: CodexWriteEvidence["generation"]): string {
  const { present, value } = generation;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`A config generation must be a non-negative safe integer, got ${String(value)}.`);
  }
  return present && value > 0 ? `gen:${value}` : "gen:0";
}

export function hashCodexWriteCoordination(
  candidate: CodexWriteCandidate,
  evidence: CodexWriteEvidence,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      // The output, hashed directly. Two operations that intend different bytes
      // cannot share an id, however they came to differ.
      createHash("sha256").update(candidate.configBytes).digest("hex"),
      createHash("sha256").update(candidate.profileBytes).digest("hex"),
      candidate.catalogPath,
      evidence.nativeInputIdentity,
      evidence.persistedIdentity,
      generationToken(evidence.generation),
      evidence.journalIdentity,
      evidence.canonicalTargets,
    ]))
    .digest("hex");
}

export function codexWriteCoordination(
  candidate: CodexWriteCandidate,
  evidence: CodexWriteEvidence,
  observedOwnership: CodexWriteCoordination["observedOwnership"],
): CodexWriteCoordination {
  return {
    candidate,
    evidence,
    observedOwnership,
    comparisonId: hashCodexWriteCoordination(candidate, evidence),
  };
}
