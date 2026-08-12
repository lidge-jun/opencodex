import { MAX_BYTES_PER_ARTIFACT, MAX_AGGREGATE_ARTIFACT_BYTES, MAX_ARTIFACTS_PER_RUN, ARTIFACT_FILENAME_EXT, type ArtifactClass, type ContractArtifactClass } from "../constants";
import {
  artifactBytesDigest,
  claimSourceManifestDigest,
  fixtureDigest,
  isSha256Hex,
  jcsStringify,
  scenarioManifestDigest,
  suiteManifestDigest,
} from "../digest";
import type { ArtifactRefV1, ClaimSourceManifestV1 } from "../events/types";
import { artifactClassMediaType, validateClaimSourceManifest } from "../events/validate";
import {
  closeTrustedArtifactDir,
  ArtifactFsError,
  deleteArtifactBytes,
  openTrustedArtifactDir,
  putArtifactBytes,
  putNamedDigestBytes,
  readArtifactBytes,
  type TrustedArtifactDir,
} from "./secure-fs";
import { redactForArtifact, sanitizeDiagnostic } from "./sanitize";

export { ArtifactFsError, openTrustedArtifactDir };
export type { TrustedArtifactDir };

export interface PutArtifactInput {
  artifactClass: ArtifactClass;
  /** Pre-redaction payload; sanitizer runs before hash/write. */
  payload: Uint8Array | string | unknown;
  mediaType?: string;
  redactionPolicy?: string;
  /** For contract artifacts whose digest uses a domain other than artifact-bytes. */
  expectedDigest?: string;
}

export interface ArtifactReadOptions {
  expectedByteCount?: number;
  artifactClass?: ArtifactClass;
}

export interface ArtifactStore {
  dir: TrustedArtifactDir;
  put(input: PutArtifactInput): ArtifactRefV1;
  get(digest: string, expectedByteCountOrOpts?: number | ArtifactReadOptions): Uint8Array;
  getVerified(
    digest: string,
    expectedByteCountOrOpts?: number | ArtifactReadOptions,
  ): { bytes: Uint8Array; digest: string };
  remove(digest: string): void;
  close(): void;
}

function toBytes(payload: Uint8Array | string | unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return new TextEncoder().encode(jcsStringify(payload));
}

function normalizeReadOptions(value?: number | ArtifactReadOptions): ArtifactReadOptions {
  return typeof value === "number" ? { expectedByteCount: value } : value ?? {};
}

function parseContractJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function jsonDigest(
  digest: (value: Record<string, unknown>) => string,
): (bytes: Uint8Array) => string {
  return (bytes) => {
    try {
      return digest(parseContractJson(bytes) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof ArtifactFsError) throw err;
      throw new ArtifactFsError("artifact_mismatch", "artifact content is not valid contract JSON");
    }
  };
}

function digestForArtifactClass(artifactClass: ArtifactClass): (bytes: Uint8Array) => string {
  switch (artifactClass) {
    case "fixture":
      return fixtureDigest;
    case "scenario_manifest":
      return jsonDigest(scenarioManifestDigest);
    case "suite_manifest":
      return jsonDigest(suiteManifestDigest);
    case "claim_source_manifest":
      return (bytes) => {
        try {
          const parsed = parseContractJson(bytes);
          return claimSourceManifestDigest(validateClaimSourceManifest(parsed).manifest);
        } catch (err) {
          if (err instanceof ArtifactFsError) throw err;
          throw new ArtifactFsError("artifact_mismatch", "claim-source artifact failed validation");
        }
      };
    default:
      return artifactBytesDigest;
  }
}

export function createArtifactStore(artifactsDir: string): ArtifactStore {
  const dir = openTrustedArtifactDir(artifactsDir);
  let aggregateBytes = 0;
  let putCount = 0;

  const getVerified = (
    digest: string,
    expectedByteCountOrOpts?: number | ArtifactReadOptions,
  ): { bytes: Uint8Array; digest: string } => {
    const opts = normalizeReadOptions(expectedByteCountOrOpts);
    const candidates = opts.artifactClass
      ? [digestForArtifactClass(opts.artifactClass)]
      : [
          artifactBytesDigest,
          fixtureDigest,
          jsonDigest(scenarioManifestDigest),
          jsonDigest(suiteManifestDigest),
          digestForArtifactClass("claim_source_manifest"),
        ];

    let lastErr: unknown;
    for (const contentDigest of candidates) {
      try {
        const got = readArtifactBytes(dir, digest, {
          expectedByteCount: opts.expectedByteCount,
          contentDigest,
        });
        return { bytes: got.bytes, digest: got.digest };
      } catch (err) {
        lastErr = err;
        if (
          err instanceof ArtifactFsError &&
          err.code !== "artifact_mismatch" &&
          !err.message.includes("mismatch")
        ) {
          throw err;
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new ArtifactFsError("artifact_mismatch", "artifact digest verification failed");
  };

  return {
    dir,
    put(input: PutArtifactInput): ArtifactRefV1 {
      if (putCount >= MAX_ARTIFACTS_PER_RUN) {
        throw new ArtifactFsError("budget_exhausted", "maximum artifacts per run exceeded");
      }
      if (input.payload instanceof Uint8Array && input.payload.byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      if (typeof input.payload === "string" && new TextEncoder().encode(input.payload).byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      const redacted = redactForArtifact(input.artifactClass, input.payload);
      const bytes = toBytes(redacted);
      if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
        throw new ArtifactFsError("budget_exhausted", `artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
      }
      if (aggregateBytes + bytes.byteLength > MAX_AGGREGATE_ARTIFACT_BYTES) {
        throw new ArtifactFsError("budget_exhausted", "aggregate artifact ceiling exceeded");
      }

      let stored;
      if (isContractClass(input.artifactClass)) {
        const contractClass = input.artifactClass;
        let computedDigest: string;
        try {
          computedDigest = computeContractDigest(contractClass, bytes, redacted);
        } catch (err) {
          if (err instanceof ArtifactFsError) throw err;
          throw new ArtifactFsError(
            "artifact_mismatch",
            err instanceof Error ? err.message : "contract artifact failed validation",
          );
        }
        if (input.expectedDigest !== undefined && computedDigest !== input.expectedDigest) {
          throw new ArtifactFsError("artifact_mismatch", "contract artifact digest mismatch");
        }
        stored = putNamedDigestBytes(
          dir,
          computedDigest,
          bytes,
          digestForArtifactClass(contractClass),
        );
      } else {
        stored = putArtifactBytes(dir, bytes, input.expectedDigest);
      }

      putCount += 1;
      aggregateBytes += stored.byteCount;
      return {
        digest: stored.digest,
        mediaType: input.mediaType ?? artifactClassMediaType(input.artifactClass),
        byteCount: stored.byteCount,
        redactionPolicy: input.redactionPolicy ?? defaultRedactionPolicy(input.artifactClass),
        relativePath: `${stored.digest}${ARTIFACT_FILENAME_EXT}`,
        artifactClass: input.artifactClass,
      };
    },
    get(digest: string, expectedByteCountOrOpts?: number | ArtifactReadOptions): Uint8Array {
      return getVerified(digest, expectedByteCountOrOpts).bytes;
    },
    getVerified,
    remove(digest: string): void {
      deleteArtifactBytes(dir, digest);
    },
    close(): void {
      closeTrustedArtifactDir(dir);
    },
  };
}

function isContractClass(c: ArtifactClass): c is ContractArtifactClass {
  return (
    c === "scenario_manifest" ||
    c === "suite_manifest" ||
    c === "fixture" ||
    c === "claim_source_manifest"
  );
}

function computeContractDigest(
  artifactClass: ContractArtifactClass,
  bytes: Uint8Array,
  redacted: unknown,
): string {
  switch (artifactClass) {
    case "fixture":
      return fixtureDigest(bytes);
    case "scenario_manifest":
      return scenarioManifestDigest(
        typeof redacted === "object" && redacted ? (redacted as Record<string, unknown>) : parseContractJson(bytes) as Record<string, unknown>,
      );
    case "suite_manifest":
      return suiteManifestDigest(
        typeof redacted === "object" && redacted ? (redacted as Record<string, unknown>) : parseContractJson(bytes) as Record<string, unknown>,
      );
    case "claim_source_manifest": {
      const parsed = typeof redacted === "object" && redacted
        ? redacted
        : parseContractJson(bytes);
      return claimSourceManifestDigest(validateClaimSourceManifest(parsed).manifest);
    }
    default: {
      const _never: never = artifactClass;
      return _never;
    }
  }
}

function defaultRedactionPolicy(artifactClass: ArtifactClass): string {
  switch (artifactClass) {
    case "scenario_manifest":
    case "suite_manifest":
    case "fixture":
    case "claim_source_manifest":
      return "contract_canonical_v1";
    default:
      // v2 marks the sanitizer that also redacts network and account
      // identifiers. The field records which algorithm produced the bytes, so
      // it moves whenever those semantics change.
      return "sanitized_evidence_v2";
  }
}

export function putClaimSourceManifest(
  store: ArtifactStore,
  manifest: ClaimSourceManifestV1,
): ArtifactRefV1 {
  const { manifest: validated, digest } = validateClaimSourceManifest(manifest);
  return store.put({
    artifactClass: "claim_source_manifest",
    payload: validated,
    expectedDigest: digest,
  });
}

export type LoadClaimSourceManifestResult =
  | { ok: true; manifest: ClaimSourceManifestV1; corruption?: undefined }
  | { ok: false; manifest: ClaimSourceManifestV1 | null; corruption: string };

export function loadClaimSourceManifest(
  store: ArtifactStore,
  digest: string,
  expected: { subjectId: string; capability: string },
): LoadClaimSourceManifestResult {
  if (!isSha256Hex(digest)) return { ok: false, manifest: null, corruption: "invalid digest" };
  try {
    const bytes = store.get(digest, { artifactClass: "claim_source_manifest" });
    const parsed = parseContractJson(bytes);
    const { manifest, digest: recomputed } = validateClaimSourceManifest(parsed);
    if (recomputed !== digest) return { ok: false, manifest, corruption: "claim-source digest mismatch" };
    if (manifest.subjectId !== expected.subjectId) return { ok: false, manifest, corruption: "claim-source subjectId mismatch" };
    if (manifest.capability !== expected.capability) return { ok: false, manifest, corruption: "claim-source capability mismatch" };
    return { ok: true, manifest };
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      corruption: sanitizeDiagnostic(err),
    };
  }
}
