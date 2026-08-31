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
import { join } from "node:path";
import {
  ClientPathError,
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
  ompAgentDir,
  ompModelsConfigPath,
  opencodeGlobalConfigPath,
  openclawConfigPath,
  openclawHomeDir,
  piAgentDir,
  piConfigPath,
  primeAgentDir,
  primeConfigPath,
  zcodeConfigPath,
  zcodeHomeDir,
  type ExportClientId,
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
  /** Patch only this block-map YAML leaf; never re-render the shared file. */
  sourcePreservingYaml?: { path: readonly string[] };
  /** Coordinate the complete mutation through a sibling config lock. */
  writerLock?: { suffix: ".lock" };
  /**
   * Derive the config path AND the detect directory from one resolution, for a
   * client whose paths depend on mutable state rather than only env and home.
   *
   * Only Aside needs this. Its two paths both come from the account id in
   * `accounts.json`, so calling `configPath` and `detectDir` in sequence can
   * straddle an account switch and check one account's install while writing
   * another's catalog. Reading the id once and deriving both paths from it
   * removes the window instead of narrowing it.
   */
  resolvePaths?: (env?: NodeJS.ProcessEnv, home?: string) => { configPath: string; detectDir: string };
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
): { configPath: string; detectDir: string } {
  const spec = INTEGRATION_CLIENTS[clientId];
  if (spec.resolvePaths) return spec.resolvePaths(env, home);
  return { configPath: spec.configPath(env, home), detectDir: spec.detectDir(env, home) };
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
};

export const INTEGRATION_CLIENT_IDS: readonly IntegrationClientId[] =
  Object.keys(INTEGRATION_CLIENTS) as IntegrationClientId[];

export function isIntegrationClientId(value: string): value is IntegrationClientId {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_CLIENTS, value);
}
