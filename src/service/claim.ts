/**
 * `ocx service claim` — record an ownership claim the embedding shell already got consent for.
 *
 * The desktop cannot write the record itself: the claim has to be committed under the
 * ownership mutation lease, against the subject and managing-CLI compatibility the caller
 * observed, by the module that owns all three. `recordServiceOwner` is that module; this
 * verb is the wire that hands it the approval `ocx resolve --json` produced.
 *
 * Every expectation is mandatory because the claim is only valid against the exact answer
 * the consent prompt was approved from. A subject or compatibility that moved in between
 * is a fresh situation, and fresh approval is the only thing that covers it.
 */
import {
  recordServiceOwner,
  resolveServiceState,
  type RecordServiceOwnerDeps,
  type ServiceOwner,
  type ServiceOwnershipSubject,
} from "./state";
import {
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
} from "./install-state-contract.mjs";
import { observeManagingClis } from "./managing-cli";
import type { ManagingCliObservation, ManagingCliRole } from "./ownership-compatibility";

export const CLAIM_SCHEMA = "ocx-service-claim/1";

const CLAIM_USAGE = [
  "Usage: ocx service claim --owner <cli|desktop> --install-id <id>",
  "    (--expect-none | --expect-owner <cli|desktop> --expect-install-id <id> --expect-generation <n>)",
  "    --expect-revision <n> --expect-compatibility-token <hex> [--json]",
].join("\n");

export interface ClaimArgs {
  owner: ServiceOwner;
  installId: string;
  expectedSubject: ServiceOwnershipSubject;
  compatibilityToken: string;
  json: boolean;
}

export type ClaimParseResult = { ok: true; args: ClaimArgs } | { ok: false };

function readFlag(args: string[], index: number): string {
  return args[index + 1] ?? "";
}

function readOwner(value: string): ServiceOwner | null {
  return value === "cli" || value === "desktop" ? value : null;
}

function readRevision(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Strict parse: the whole approval arrives on argv or the invocation is a usage error. */
export function parseClaimArgs(args: string[]): ClaimParseResult {
  let owner: ServiceOwner | null = null;
  let installId: string | null = null;
  let expectNone = false;
  let expectOwner: ServiceOwner | null = null;
  let expectInstallId: string | null = null;
  let expectGeneration: number | null = null;
  let expectRevision: number | null = null;
  let token: string | null = null;
  let json = false;
  const withValue = new Set([
    "--owner", "--install-id", "--expect-owner", "--expect-install-id",
    "--expect-generation", "--expect-revision", "--expect-compatibility-token",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--expect-none") { expectNone = true; continue; }
    if (!withValue.has(arg)) return { ok: false };
    const value = readFlag(args, index);
    if (!value) return { ok: false };
    index += 1;
    switch (arg) {
      case "--owner": owner = readOwner(value); if (owner === null) return { ok: false }; break;
      case "--install-id": installId = value; break;
      case "--expect-owner": expectOwner = readOwner(value); if (expectOwner === null) return { ok: false }; break;
      case "--expect-install-id": expectInstallId = value; break;
      case "--expect-generation": expectGeneration = readRevision(value); if (expectGeneration === null) return { ok: false }; break;
      case "--expect-revision": expectRevision = readRevision(value); if (expectRevision === null) return { ok: false }; break;
      case "--expect-compatibility-token": token = value; break;
    }
  }
  if (!owner || !installId || expectRevision === null || !token) return { ok: false };
  let expectedSubject: ServiceOwnershipSubject;
  if (expectNone) {
    if (expectOwner !== null || expectInstallId !== null || expectGeneration !== null) return { ok: false };
    expectedSubject = { kind: "none", revision: expectRevision };
  } else {
    if (expectOwner === null || expectInstallId === null || expectGeneration === null) return { ok: false };
    expectedSubject = {
      kind: "owned",
      ownership: { owner: expectOwner, installId: expectInstallId, consentGeneration: expectGeneration },
      revision: expectRevision,
    };
  }
  return { ok: true, args: { owner, installId, expectedSubject, compatibilityToken: token, json } };
}

export interface ServiceClaimDeps {
  /** recordServiceOwner seam. */
  recordOwner?: typeof recordServiceOwner;
  /** The managing-CLI revalidation the record runs inside its lock. */
  observeManagers?: () => Readonly<Record<ManagingCliRole, ManagingCliObservation>>;
  /** Re-resolves the state under the lock for the observation. */
  resolveState?: typeof resolveServiceState;
  stdout?: { log: (s: string) => void };
  stderr?: { error: (s: string) => void };
}

interface ClaimError extends Error {
  code?: string;
}

/**
 * Run `ocx service claim`. Returns the exit code; the caller assigns it, so the verb
 * reports before the process decides.
 */
export async function runServiceClaim(argv: string[], deps: ServiceClaimDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? console;
  const stderr = deps.stderr ?? console;
  const parsed = parseClaimArgs(argv);
  if (!parsed.ok) {
    stderr.error(CLAIM_USAGE);
    return 64;
  }
  const { args } = parsed;
  const resolveState = deps.resolveState ?? resolveServiceState;
  const observeManagers = deps.observeManagers ?? (() => {
    const resolved = resolveState();
    if (resolved.kind === "unknown") {
      // recordServiceOwner converts a thrown observation into a compatibility-changed
      // refusal; an unreadable state under the lock is exactly that.
      throw new Error(resolved.reason);
    }
    return observeManagingClis(resolved.kind === "state" ? resolved.state : null);
  });
  const recordOwner = deps.recordOwner ?? recordServiceOwner;
  const request = {
    owner: args.owner,
    installId: args.installId,
    expectedSubject: args.expectedSubject,
    expectedCompatibility: {
      kind: "supported" as const,
      protocolVersion: SERVICE_OWNERSHIP_PROTOCOL_VERSION,
      minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
      token: args.compatibilityToken,
    },
  };
  try {
    const recordDeps: RecordServiceOwnerDeps = { observeManagers };
    const committed = recordOwner(request, recordDeps);
    if (args.json) {
      stdout.log(JSON.stringify({
        schema: CLAIM_SCHEMA,
        ok: true,
        ownership: committed.ownership,
        revision: committed.revision,
      }));
    } else {
      stdout.log(
        `✅ Recorded ${args.owner} as the runtime owner (install ${args.installId}, generation ${committed.ownership.consentGeneration}).`,
      );
    }
    return 0;
  } catch (error) {
    const claimError = error as ClaimError;
    const code = typeof claimError?.code === "string" ? claimError.code : "claim-failed";
    const message = claimError instanceof Error ? claimError.message : String(error);
    if (args.json) {
      stdout.log(JSON.stringify({ schema: CLAIM_SCHEMA, ok: false, code, message }));
    } else {
      stderr.error(`❌ ${message}`);
    }
    return 1;
  }
}
