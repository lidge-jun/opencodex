import { dirname, isAbsolute, join } from "node:path";
import { isValidRuntimePortState, type RuntimePortState } from "../config/process-state";
import { isLocalAttestationSecret } from "../lib/local-management-attestation";
import type { HomeOwnershipProof } from "../server/proxy-liveness";

type RecordRead = { kind: "record"; raw: string } | { kind: "missing" } | { kind: "unreadable" };
type RuntimeIdentity = { pid: number; port: number; hostname: string; command: readonly string[] };
export type ServingIdentity =
  | { kind: "unknown" | "absent" | "mismatch" }
  | { kind: "live"; servingRoot: string; runtime: RuntimeIdentity };

export interface ServingIdentityDeps {
  readRecord(): RecordRead;
  prove(record: RuntimePortState): Promise<HomeOwnershipProof>;
  probeConfigured(): Promise<"live" | "dead" | "unknown">;
  legacyExecutableDiffers?(pid: number): Promise<boolean>;
  realpath(path: string): string;
}

/** A live listener is usable only when it attests the same record observed before and after. */
export async function inspectOrchestratedServingIdentity(deps: ServingIdentityDeps): Promise<ServingIdentity> {
  try {
    const first = deps.readRecord();
    if (first.kind === "unreadable") return { kind: "unknown" };
    if (first.kind === "missing") {
      const endpoint = await deps.probeConfigured();
      return endpoint === "dead" && deps.readRecord().kind === "missing" ? { kind: "absent" } : { kind: "unknown" };
    }
    const parsed: unknown = JSON.parse(first.raw);
    if (!isValidRuntimePortState(parsed) || !isLocalAttestationSecret(parsed.attestationSecret)) return { kind: "unknown" };
    if (await deps.prove(parsed) !== "proven") return { kind: "unknown" };
    const after = deps.readRecord();
    if (after.kind !== "record" || after.raw !== first.raw) return { kind: "unknown" };
    const command: unknown = parsed.command;
    if (command === undefined) {
      return await deps.legacyExecutableDiffers?.(parsed.pid) ? { kind: "mismatch" } : { kind: "unknown" };
    }
    if (!Array.isArray(command) || command.length < 1 || command.length > 2 || !command.every(part => typeof part === "string" && isAbsolute(part))) return { kind: "unknown" };
    let servingRoot: string;
    if (command.length === 1) servingRoot = deps.realpath(command[0]);
    else {
      const source = command[1] as string;
      const root = dirname(dirname(dirname(source)));
      // Windows accepts both separators; only separators are equated, so dotted or doubled forms still fail.
      const native = process.platform === "win32" ? source.replace(/\//g, "\\") : source;
      if (join(root, "src", "cli", "index.ts") !== native) return { kind: "unknown" };
      servingRoot = deps.realpath(root);
    }
    return { kind: "live", servingRoot, runtime: { pid: parsed.pid, port: parsed.port, hostname: parsed.hostname ?? "127.0.0.1", command } };
  } catch {
    return { kind: "unknown" };
  }
}
