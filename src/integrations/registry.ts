/**
 * Where each file-toggle client keeps its config, and what we are allowed to do
 * to it.
 *
 * The export registry (src/clients/config-export.ts) says how to RENDER a
 * client's config. This one says where it lives, how to tell whether the client
 * is installed at all, and whether a remote bind is safe for it.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/021 §1.
 */
import { homedir } from "node:os";
import { assertDroidSettingsUnambiguous } from "./droid-settings";
import { readPath } from "./merge";
import type { OwnershipRecord } from "./ownership";
import { dirname, join } from "node:path";
import {
  ClientPathError,
  buildDroidContribution,
  clineConfigPath,
  clineSettingsDir,
  droidConfigPath,
  droidHomeDir,
  EXPORT_CLIENTS,
  asideAccountDir,
  asideConfigPath,
  asideHomeDir,
  dshConfigPath,
  dshHomeDir,
  gajaeConfigPath,
  gajaeHomeDir,
  hermesConfigPath,
  hermesHomeDir,
  kimiConfigPath,
  kimiHomeDir,
  mcodeConfigPath,
  mcodeHomeDir,
  omoAgentDir,
  omoConfigPath,
  ompAgentDir,
  ompModelsConfigPath,
  opencodeGlobalConfigPath,
  openclawConfigPath,
  openclawHomeDir,
  piAgentDir,
  piConfigPath,
  primeAgentDir,
  primeConfigPath,
  raycastAiDir,
  raycastConfigPath,
  zcodeConfigPath,
  zcodeHomeDir,
  zcodeProviderStorePath,
  buildZcodeStoreContribution,
  zcodeStoreSchemaEstablished,
  dshProfilePatchPath,
  dshProfilePatchEstablished,
  buildDshProfilePatchContribution,
  DSH_PROFILE_PROVIDER_PATH,
  type BuildContribution,
  type ConfigFormat,
  kiloConfigPath,
  kiloHomeDir,
  kiloCandidatePath,
  KILO_CONFIG_CANDIDATES,
  type ExportClientId,
  type DroidModelEntry,
  type ExportContext,
} from "../clients/config-export";

/**
 * Readability alias. WP1 owns the type; this never introduces a second one, so
 * the dependency only ever points backwards.
 */
export type IntegrationClientId = ExportClientId;

export interface IntegrationClientSpec {
  id: IntegrationClientId;
  /** The client's config file, honoring that client's own environment override. */
  configPath: (env?: NodeJS.ProcessEnv, home?: string) => string;
  /** Directory whose existence is the cheap "is it installed?" signal. */
  detectDir: (env?: NodeJS.ProcessEnv, home?: string) => string;
  /**
   * The provider store this client reads INSTEAD of `configPath`.
   *
   * A client that moves its store between releases usually keeps a one-shot
   * import from the old location, and that import is exactly what makes the old
   * write look like it still works: it runs once, on an install that has never
   * created the new file, and never again. Everything after it lands in a file
   * the client does not open.
   *
   * A declaration carries everything needed to write the store, not only its
   * location: the text format, the contribution shape its reader understands,
   * and the predicate that says whether a document on disk is a version whose
   * shape has been observed. The last one is what keeps this honest — a store
   * we cannot establish is reported as the reason the write cannot reach the
   * client, never merged into on a guess.
   */
  currentStore?: {
    path: (env?: NodeJS.ProcessEnv, home?: string) => string;
    format: ConfigFormat;
    establishes: (parsed: unknown) => boolean;
    buildContribution: BuildContribution;
    /** Patch only this leaf of the store, as `sourcePreservingYaml` does for the config file. */
    sourcePreservingYaml?: { path: readonly string[] };
    /**
     * The file whose `<file>.lock` sibling the client's own writer holds while
     * it rewrites the store. Taken after the config file's lock, whenever the
     * store's directory exists.
     */
    lockFile?: (storePath: string) => string;
    /**
     * A missing store the client already manages. Writing the config file instead would not stay
     * where opencodex records it, so the target is reported as an ineffective write with this
     * remedy rather than silently writing the config file.
     */
    missingStore?: {
      readsStore: (storePath: string, statKind: (path: string) => string) => boolean;
      remedy: string;
    };
  };
  /** Patch only this block-map YAML leaf; never re-render the shared file. */
  sourcePreservingYaml?: { path: readonly string[] };
  /** Coordinate the complete mutation through a sibling config lock. */
  writerLock?: { suffix: ".lock" };
  /**
   * Derive the config path AND the detect directory from one resolution, for a
   * client whose paths depend on mutable state rather than only env and home.
   *
   * Aside needs this because both paths come from the account id in
   * `accounts.json`: one read prevents an account switch between resolutions.
   * Droid uses the same seam to check competing settings against the export
   * context before status, preview, or mutation proceeds.
   */
  resolvePaths?: (env?: NodeJS.ProcessEnv, home?: string, exportContext?: ExportContext) => { configPath: string; detectDir: string };
  /**
   * Where the client's config WOULD live, for a client whose real path cannot
   * be resolved yet.
   *
   * Only a client with `resolvePaths` needs this, and only because that
   * resolution can legitimately fail on a machine where the client has never
   * run. Aside's account id comes from a manifest the app writes at first
   * launch, so a never-signed-in install has no account directory and no id --
   * which is "not installed", not "we cannot verify this file".
   *
   * The value is a location to SHOW, never a location to write: it names the
   * account root without an account, so it cannot be mistaken for a real
   * catalog. `resolveIntegrationPaths` still throws for callers that mutate.
   */
  unresolvedPathHint?: (env?: NodeJS.ProcessEnv, home?: string) => string;
  /**
   * Recognize a resolution drift that is still THIS client's own file, for a
   * client whose config path depends on mutable world state rather than only
   * env and home.
   *
   * Kilo resolves to the first EXISTING candidate, so a candidate created
   * after apply moves resolution while the owned file still holds our block.
   * While this predicate accepts the recorded path, reads and mutations stay
   * bound to it instead of silently re-homing onto the newcomer. A client
   * without this hook never binds: a record from another home stays a refusal
   * ("a record for one home cannot authorize a write to another").
   */
  bindsDriftedRecord?: (recordPath: string, env?: NodeJS.ProcessEnv, home?: string) => boolean;
}

/**
 * The one place that turns a client id into the pair of paths an operation uses.
 *
 * A caller that resolves `configPath` and `detectDir` separately is correct for
 * every client whose paths are a pure function of env and home, and wrong for
 * one that reads mutable state. Routing both through here lets such a client fix
 * that for itself without every call site learning why.
 */
export function resolveIntegrationPaths(
  clientId: IntegrationClientId,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exportContext?: ExportContext,
): { configPath: string; detectDir: string } {
  const spec = INTEGRATION_CLIENTS[clientId];
  if (spec.resolvePaths) return spec.resolvePaths(env, home, exportContext);
  return { configPath: spec.configPath(env, home), detectDir: spec.detectDir(env, home) };
}

export function assertDroidPathsUnambiguous(root: string, exportContext?: ExportContext): void {
  try {
    const generated = exportContext ? buildDroidContribution(exportContext).fragments : [];
    assertDroidSettingsUnambiguous(root, exportContext?.baseUrl, generated.map(fragment => (fragment.value as DroidModelEntry).model));
  }
  catch (error) { throw new ClientPathError((error as Error).message); }
}

/** Check the identities still owned on disk even after they leave the catalog. */
export function assertDroidRecordedSettingsUnambiguous(root: string, parsed: unknown, record: OwnershipRecord): void {
  try {
    const byEndpoint = new Map<string, Set<string>>();
    for (const path of record.fragmentPaths) {
      const row = readPath(parsed, path) as Partial<DroidModelEntry> | undefined;
      if (typeof row?.baseUrl !== "string" || typeof row.model !== "string") {
        throw new Error("Cannot verify recorded Factory Droid rows");
      }
      const models = byEndpoint.get(row.baseUrl) ?? new Set<string>();
      models.add(row.model);
      byEndpoint.set(row.baseUrl, models);
    }
    for (const [baseUrl, models] of byEndpoint) assertDroidSettingsUnambiguous(root, baseUrl, [...models]);
  } catch (error) { throw new ClientPathError((error as Error).message); }
}

/**
 * The location to name when resolution refused, or `""` when there is none.
 *
 * A read-only surface reporting "unresolvable" with an empty path told the user
 * nothing they could act on, and for Aside it also reported the wrong thing: an
 * absent account manifest is the ordinary state of an installed-but-never-run
 * Aside, and the honest answer there is that it is not signed in.
 *
 * `""` is a sentinel, not a path: it is what `readIntegrationState` reads to
 * decide between not-installed and cannot-verify. A config path is never
 * legitimately empty, and a hint is always an absolute `join` result, so the two
 * cannot be confused.
 */
export function unresolvedPathHintFor(
  clientId: IntegrationClientId,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const spec = INTEGRATION_CLIENTS[clientId];
  if (!spec.unresolvedPathHint) return "";
  try {
    return spec.unresolvedPathHint(env, home);
  } catch (error) {
    /*
     * Only a path refusal is absorbed. An unqualified catch here would also
     * swallow a TypeError from a future implementor's typo, an
     * ERR_INVALID_ARG_TYPE out of `join`, or an EACCES from a resolver that
     * touches the filesystem -- turning a programming error into a silently
     * degraded badge. `readIntegrationState` narrows the same way at its own
     * catch, and this is the matching half.
     */
    if (!(error instanceof ClientPathError)) throw error;
    return "";
  }
}

/**
 * True when the client has nowhere to put the dedicated admission header a
 * non-loopback bind requires, so a generated config would simply be rejected.
 *
 * Read from the export registry rather than restated here: two lists of the
 * same fact drift, and this one decides whether we write a file that 401s.
 */
export function isLoopbackOnly(clientId: IntegrationClientId): boolean {
  return EXPORT_CLIENTS[clientId].loopbackOnly;
}

function xdgConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : join(home, ".config");
}

export const INTEGRATION_CLIENTS: Record<IntegrationClientId, IntegrationClientSpec> = {
  opencode: {
    id: "opencode",
    // These take `home` explicitly. The export registry's `destination` reads
    // the real home directory, which is right for telling a user where their
    // file lives and wrong for a writer that a test must be able to redirect.
    configPath: (env = process.env, home = homedir()) => opencodeGlobalConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => join(xdgConfigHome(env, home), "opencode"),
  },
  pi: {
    id: "pi",
    configPath: (env = process.env, home = homedir()) => piConfigPath(env, home),
    /*
     * Deliberately not `piAgentDir` unconditionally. Without an override the
     * install signal stays `~/.pi`, which is what it has always been: narrowing
     * it to `~/.pi/agent` would flip a user who has the former without the
     * latter from installed to absent, and this change is about honoring the
     * override, not about redefining detection. With an override there is no
     * parent worth testing — the variable names the agent directory itself — so
     * that directory becomes the signal.
     */
    detectDir: (env = process.env, home = homedir()) =>
      env.PI_CODING_AGENT_DIR?.trim() ? piAgentDir(env, home) : join(home, ".pi"),
  },
  omp: {
    id: "omp",
    configPath: (env = process.env, home = homedir()) => ompModelsConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => ompAgentDir(env, home),
    sourcePreservingYaml: { path: ["providers", "opencodex"] },
  },
  hermes: {
    id: "hermes",
    configPath: (env = process.env, home = homedir()) => hermesConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => hermesHomeDir(env, home),
    sourcePreservingYaml: { path: ["providers", "opencodex"] },
  },
  openclaw: {
    id: "openclaw",
    configPath: (env = process.env, home = homedir()) => openclawConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => openclawHomeDir(env, home),
  },
  kimi: {
    id: "kimi",
    configPath: (env = process.env, home = homedir()) => kimiConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => kimiHomeDir(env, home),
    // Kimi reads credentials only from config.toml — it never consults the
    // environment — so there is no way to point it at a remote bind without
    // serializing the user's key.
  },
  gajae: {
    id: "gajae",
    configPath: (env = process.env, home = homedir()) => gajaeConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => gajaeHomeDir(env, home),
  },
  dsh: {
    id: "dsh",
    configPath: (env = process.env, home = homedir()) => dshConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => dshHomeDir(env, home),
    sourcePreservingYaml: { path: ["llm-pi-ai", "providers", "opencodex"] },
    writerLock: { suffix: ".lock" },
    /*
     * DSH 0.1.7+ imports `settings.yaml` once into the first profile that boots
     * and renames it; what it reads afterwards is the Desktop profile's patch.
     */
    currentStore: {
      path: (env = process.env, home = homedir()) => dshProfilePatchPath(env, home),
      format: "yaml",
      establishes: dshProfilePatchEstablished,
      buildContribution: buildDshProfilePatchContribution,
      sourcePreservingYaml: { path: DSH_PROFILE_PROVIDER_PATH },
      // DSH's config editor serializes profile edits on the profile manifest's lock.
      lockFile: store => join(dirname(store), "package.json"),
      // A Desktop profile manifest without its patch is a profile DSH manages. On each startup
      // DSH's importLegacyDocument renames `settings.yaml` to `settings.yaml.imported` and imports
      // it into the active profile, so a block written there would leave opencodex's ownership
      // record pointing at a file that no longer exists. Refuse it and name the remedy instead.
      missingStore: {
        readsStore: (store, statKind) => statKind(join(dirname(store), "package.json")) === "file",
        remedy: "Create it containing `[]` (the empty patch DSH writes for a new profile), then enable the integration again.",
      },
    },
  },
  mcode: {
    id: "mcode",
    configPath: (env = process.env, home = homedir()) => mcodeConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => mcodeHomeDir(env, home),
    writerLock: { suffix: ".lock" },
  },
  zcode: {
    id: "zcode",
    configPath: (env = process.env, home = homedir()) => zcodeConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => zcodeHomeDir(env, home),
    /*
     * ZCode 3.14 reads its providers from `v2/provider_config.json` and reaches
     * `v2/config.json` only through the import that seeded it. Where the new
     * file exists the import is spent, so our write is read by nobody (#5348).
     */
    currentStore: {
      path: (env = process.env, home = homedir()) => zcodeProviderStorePath(env, home),
      format: "json",
      establishes: zcodeStoreSchemaEstablished,
      buildContribution: buildZcodeStoreContribution,
    },
  },
  prime: {
    id: "prime",
    configPath: (env = process.env, home = homedir()) => primeConfigPath(env, home),
    // The agent directory, not its parent: `PRIME_AGENT_CODING_AGENT_DIR` names
    // that directory directly, so there is no parent to test when the override
    // is set. Same choice as OMP, whose detect signal is `ompAgentDir`.
    detectDir: (env = process.env, home = homedir()) => primeAgentDir(env, home),
  },
  aside: {
    id: "aside",
    configPath: (env = process.env, home = homedir()) => asideConfigPath(env, home),
    /*
     * The ACCOUNT directory, not `~/.aside`. Aside's CLI creates `~/.aside/cli`
     * for its own update check before any account exists, so the outer directory
     * is present on a machine that never signed in, and writing a catalog for an
     * account that does not exist is worse than reporting absent.
     */
    detectDir: (env = process.env, home = homedir()) => asideAccountDir(env, home),
    /*
     * Both paths from ONE account read. The two resolvers above each consult
     * the account manifest, so a switch landing between them would let an
     * operation verify one account's install and then write another's catalog.
     */
    resolvePaths: (env = process.env, home = homedir()) => {
      const detectDir = asideAccountDir(env, home);
      return { configPath: join(detectDir, "models.json"), detectDir };
    },
    /*
     * The account ROOT, with no account under it. Aside writes `accounts.json`
     * at first launch, so its absence is the ordinary state of an Aside that has
     * been installed and never signed into -- and a page that answered "cannot
     * verify" with an empty path for that case named nothing the user could go
     * look at.
     */
    unresolvedPathHint: (env = process.env, home = homedir()) => join(asideHomeDir(env, home), "u"),
  },
  raycast: {
    id: "raycast",
    configPath: (env = process.env, home = homedir()) => raycastConfigPath(env, home),
    /*
     * The `ai` directory, not `Raycast.app`. Raycast creates it only when the
     * user clicks "Reveal Providers Config" in Settings > AI, which is exactly
     * the signal that Custom Providers is reachable on this install; an app
     * bundle alone says nothing about the plan or the feature.
     *
     * No `sourcePreservingYaml`: that patcher handles block-map leaves only,
     * and our entry is a SEQUENCE item, so the file is re-rendered through
     * `renderYaml` (block style). The `[id=opencodex]` selector keeps the user's
     * other providers in place across that re-render.
     */
    detectDir: (env = process.env, home = homedir()) => raycastAiDir(env, home),
  },
  omo: {
    id: "omo",
    configPath: (env = process.env, home = homedir()) => omoConfigPath(env, home),
    /*
     * The AGENT directory, not `~/.omo`. The v4 launcher wrapper creates
     * `~/.omo` to hold `binary-runtime` without ever creating `agent/`, so
     * detecting on the parent reports an omo v5 install that is not there --
     * and `installed` is what stops apply from writing a catalog for an engine
     * that will never read it. Prime's agent directory and Aside's account
     * directory are the same shape; Pi's parent-directory check is the odd one.
     *
     * No `sourcePreservingYaml` (JSON), no `writerLock` (single writer), and no
     * `resolvePaths` -- unlike Aside, both omo paths are a pure function of env
     * and home, so reading them in sequence cannot straddle a state change.
     */
    detectDir: (env = process.env, home = homedir()) => omoAgentDir(env, home),
  },
  cline: {
    id: "cline",
    configPath: (env = process.env, home = homedir()) => clineConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => clineSettingsDir(env, home),
    writerLock: { suffix: ".lock" },
  },
  kilo: {
    id: "kilo",
    configPath: (env = process.env, home = homedir()) => kiloConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => kiloHomeDir(env, home),
    bindsDriftedRecord: (recordPath, env = process.env, home = homedir()) =>
      KILO_CONFIG_CANDIDATES.some(name => recordPath === kiloCandidatePath(kiloHomeDir(env, home), name)),
  },
  droid: {
    id: "droid",
    configPath: (env = process.env, home = homedir()) => droidConfigPath(env, home),
    detectDir: (env = process.env, home = homedir()) => droidHomeDir(env, home),
    resolvePaths: (env = process.env, home = homedir(), exportContext) => {
      const detectDir = droidHomeDir(env, home);
      assertDroidPathsUnambiguous(detectDir, exportContext);
      return { configPath: droidConfigPath(env, home), detectDir };
    },
  },
};

export const INTEGRATION_CLIENT_IDS: readonly IntegrationClientId[] =
  Object.keys(INTEGRATION_CLIENTS) as IntegrationClientId[];

/**
 * The effective config path for a read or mutation, given the ownership record.
 *
 * One implementation for status AND the mutation planner: when only one side
 * carried the binding, the two could disagree again and status would report a
 * file the writer never touches. Binds only while the client's own
 * `bindsDriftedRecord` accepts the recorded path (still one of that client's
 * candidates under the CURRENT env and home) and the file still exists; a
 * record from another home never binds and keeps its refusal contract.
 */
export function boundIntegrationConfigPath(input: {
  clientId: IntegrationClientId;
  record: { clientId: IntegrationClientId; configPath: string } | null;
  resolvedPath: string;
  statKind: (path: string) => string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const record = input.record;
  if (
    record && record.clientId === input.clientId &&
    record.configPath !== input.resolvedPath &&
    input.statKind(record.configPath) === "file" &&
    INTEGRATION_CLIENTS[input.clientId].bindsDriftedRecord?.(record.configPath, input.env, input.home) === true
  ) {
    return record.configPath;
  }
  return input.resolvedPath;
}

/**
 * Why a historical restore must not run, or null when it may.
 *
 * Kilo keeps one ownership record and may legally have written more than one
 * candidate. Treating every same-home journaled path as a restore target lets
 * an undo of an older file commit that file's prior record over the candidate
 * that owns the integration now. The managed block in the current file stays
 * on disk, the record points at the old file, and a later disable drops the
 * record and orphans the newcomer.
 *
 * A missing current record is not a collision: undoing the disable that
 * dropped it still restores the journaled file. A client without
 * bindsDriftedRecord is unchanged, because that seam is what made the second
 * candidate a legal target. Direct restore and its preview both ask here, so
 * they cannot admit different answers.
 */
export function restoreOwnershipCollision(input: {
  clientId: IntegrationClientId;
  journaledPath: string;
  currentPath: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string | null {
  const currentPath = input.currentPath;
  if (currentPath === null || currentPath === input.journaledPath) return null;
  const binds = INTEGRATION_CLIENTS[input.clientId].bindsDriftedRecord;
  if (!binds) return null;
  if (binds(input.journaledPath, input.env, input.home) !== true) return null;
  if (binds(currentPath, input.env, input.home) !== true) return null;
  return `that operation was recorded for ${input.journaledPath}, but ${currentPath} currently owns this integration`;
}

export function isIntegrationClientId(value: string): value is IntegrationClientId {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_CLIENTS, value);
}
