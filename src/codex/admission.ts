/**
 * The `AdmissionSnapshot` producer.
 *
 * `AdmissionSnapshot` existed as a TYPE for the whole unit while nothing built
 * one, which meant the write lock's API could only ever be exercised by a
 * fabricated object — the reason WP11 was merged into WP12 rather than shipped
 * as a mechanism with no consumer.
 *
 * What this is FOR: one decision uses one set of bytes. Everything the lock
 * compares is captured here, once, before any artifact is created; the lock then
 * re-reads it while holding N and refuses if the authority moved underneath.
 * Passing the config around instead would let two reads of a changing file
 * disagree inside one operation, which is the interruption hazard this unit
 * exists to close.
 *
 * READS ONLY. Nothing here creates a directory, a database, or a marker: an
 * admission that manufactures the state it is admitting cannot refuse.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/040_ownership_convergence.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDir, observeConfigGeneration, readConfigAdmissionSnapshot } from "../config";
import { inspectNativeCodexOwnership } from "../integrations/native/ownership-preflight";
import type { AdmissionSnapshot } from "./convergence-types";
import { codexIntegrationEnabled } from "./desired-state";
import { externalCodexModelProvider } from "./inject";
import { JOURNAL_PATH } from "./journal";
import {
  CODEX_MODELS_CACHE_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  resolveCodexStateDbPath,
} from "./paths";

export type CodexAdmission =
  | { readonly kind: "admitted"; readonly snapshot: AdmissionSnapshot }
  | {
      readonly kind: "refused";
      readonly authority: "config" | "generation" | "service-home" | "external-provider";
      readonly message: string;
    };

/**
 * Seams, not conveniences.
 *
 * The ownership probe shells out to the platform service manager, and a test
 * that reached the real one would be asserting against whatever the developer's
 * machine happens to have installed. Injecting it is also what lets a test
 * observe the EXACT argv the production probe emits, which is the only way to
 * hold down "this never starts or stops anything".
 */
export interface AdmissionDeps {
  readonly inspectOwnership?: typeof inspectNativeCodexOwnership;
}

/** Hash of a file's exact bytes, or a stable marker for absence. */
function contentIdentity(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    // Absence is EVIDENCE, not a hole. An absent journal and an unreadable one
    // are different states and must not collapse to the same identity.
    return existsSync(path) ? "unreadable" : "absent";
  }
}

/**
 * Capture everything one Codex write decision depends on.
 *
 * Refuses rather than guessing: a missing or malformed config, a coordinator
 * that cannot report a generation, a service installed from another home, and an
 * external `model_provider` each end the operation before it starts. The last
 * two are separate authorities on purpose — "someone else's service owns this
 * home" and "the user pointed Codex somewhere else" need different messages
 * because they need different actions.
 */
export function admitCodexWrite(deps: AdmissionDeps = {}): CodexAdmission {
  const persisted = readConfigAdmissionSnapshot();
  const diagnostics = persisted.diagnostics;
  if (diagnostics.source !== "file") {
    return {
      kind: "refused",
      authority: "config",
      message: diagnostics.source === "default"
        ? "No config file exists to admit a Codex write from."
        : "The config file is malformed; refusing to write from it.",
    };
  }
  if (persisted.kind !== "read") {
    // Unreachable through the union today — `source: "file"` only comes from a
    // successful read — but stated rather than assumed, because the day that
    // stops being true this should refuse, not proceed with no digest.
    return {
      kind: "refused",
      authority: "config",
      message: "The config file could not be read as bytes; refusing to write from it.",
    };
  }

  /*
   * OBSERVE, not read.
   *
   * `readConfigGeneration` opens the coordinator with `create: true`, so merely
   * admitting would produce a `config-mutation.sqlite` in a home that had none —
   * caught by the "creates nothing" test, which is what that test is for. Only a
   * cooperating config WRITE may create and initialize the singleton.
   */
  const observed = observeConfigGeneration();
  if (observed.kind === "unavailable") {
    return {
      kind: "refused",
      authority: "generation",
      message: observed.reason === "busy"
        ? "The config coordinator is busy; the generation could not be read."
        : "The config generation exists but could not be read; refusing to guess it.",
    };
  }
  const generation = observed.kind === "absent"
    ? { present: false, value: 0 }
    : { present: true, value: observed.generation.value };

  /*
   * Tri-state, and NOT `assertNativeTeardownOwned` — that one fails open, so a
   * corrupt state file would arrive here as `owned`. Unattended writes refuse on
   * both `foreign` and `unknown`: the first is someone else's home, the second
   * is a question that could not be answered, and neither is permission.
   */
  const ownership = (deps.inspectOwnership ?? inspectNativeCodexOwnership)();
  if (ownership.ownership !== "owned") {
    return {
      kind: "refused",
      authority: "service-home",
      message: ownership.ownership === "foreign"
        ? `Refusing to write: ${ownership.reason}.`
        : `Refusing to write because ownership could not be proven: ${ownership.reason}.`,
    };
  }

  const codexHome = getCodexHome();
  const codexConfigPath = join(codexHome, "config.toml");
  let external: string | null = null;
  try {
    // Resolved at call time, not at module load: CODEX_CONFIG_PATH is a const
    // fixed when the module was first imported, so it does not follow a
    // CODEX_HOME that changed afterwards.
    external = externalCodexModelProvider(readFileSync(codexConfigPath, "utf-8"));
  } catch {
    // No Codex config yet is not an external owner; it is simply nothing to read.
    external = null;
  }
  if (external) {
    return {
      kind: "refused",
      authority: "external-provider",
      message: `Codex config.toml is owned by an external model_provider (${external}).`,
    };
  }

  const config = diagnostics.config;
  const opencodexHome = getConfigDir();
  const integrationRecord = join(opencodexHome, "integrations", "codex.json");
  const historyDb = resolveCodexStateDbPath({ codexHome });

  const canonicalTargets = {
    codexHome,
    opencodexHome,
    config: codexConfigPath,
    profile: CODEX_PROFILE_PATH,
    catalog: DEFAULT_CATALOG_PATH,
    cache: CODEX_MODELS_CACHE_PATH,
    // The journal's own constant. Re-deriving it here is what made this field
    // watch a path nothing writes.
    journal: JOURNAL_PATH,
    integrationRecord,
    // Backups and rollouts are enumerated by their owners, not guessed here.
    catalogBackups: [] as readonly string[],
    historyDb,
    historyManifest: `${historyDb}.ocx-backup.json`,
    historyRollouts: [] as readonly string[],
  } as const;

  const snapshot: AdmissionSnapshot = {
    config,
    // The EXACT persisted bytes. Hashing the parsed object instead let a
    // whitespace-only rewrite pass unnoticed, which is precisely the
    // non-cooperating writer this comparison exists to catch.
    configDigest: persisted.contentSha256,
    intent: codexIntegrationEnabled(config) ? "on" : "off",
    generation,
    // Reached only when the projection above said `owned`; the other two states
    // have already refused. This is the observed value, not a placeholder.
    ownership: ownership.ownership,
    externalProvider: null,
    canonicalTargets,
    journalIdentity: contentIdentity(JOURNAL_PATH),
    provenanceIdentity: contentIdentity(integrationRecord),
    authoritySnapshotId: "",
  };

  return { kind: "admitted", snapshot: { ...snapshot, authoritySnapshotId: hashAuthority(snapshot) } };
}

/**
 * Collapse the generation to one authority token.
 *
 * An absent database and a present zero are the SAME authority — both mean no
 * cooperating write has committed — and they must hash alike, because the lock
 * compares this ID byte-for-byte. They cannot be observed alike: before the lock
 * only absence is visible, and inside it only the present zero is, since the
 * transaction that creates the row has not committed while a separate connection
 * looks. Without this they would never match and every first write would refuse.
 *
 * Canonicalizing inside the hash rather than beside it, in a comparator: a
 * comparator that treats one field specially has to be rewritten at every future
 * comparison site, and the site that gets forgotten is the one that matters.
 */
function generationAuthority(generation: AdmissionSnapshot["generation"]): string {
  const { present, value } = generation;
  if (!Number.isSafeInteger(value) || value < 0) {
    // NaN, Infinity, fractions, negatives and unsafe integers would otherwise
    // all quietly become "gen:0" — the one value that means "safe to proceed".
    throw new TypeError(`A config generation must be a non-negative safe integer, got ${String(value)}.`);
  }
  return present && value > 0 ? `gen:${value}` : "gen:0";
}

/**
 * Digest every authority field, in a fixed order.
 *
 * The lock compares THIS and nothing else, so a field left out of the hash is a
 * field that can change under the lock without anyone noticing. Adding one to
 * the snapshot means adding it here.
 */
export function hashAuthority(snapshot: AdmissionSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify([
      snapshot.configDigest,
      snapshot.intent,
      generationAuthority(snapshot.generation),
      snapshot.ownership,
      snapshot.externalProvider,
      snapshot.canonicalTargets,
      snapshot.journalIdentity,
      snapshot.provenanceIdentity,
    ]))
    .digest("hex");
}

/** Test seam: prove the identity of a path the way admission does. */
export function admissionContentIdentityForTests(path: string): string {
  return contentIdentity(path);
}
