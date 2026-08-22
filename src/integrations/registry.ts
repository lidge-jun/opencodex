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
  EXPORT_CLIENTS,
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
};

export const INTEGRATION_CLIENT_IDS: readonly IntegrationClientId[] =
  Object.keys(INTEGRATION_CLIENTS) as IntegrationClientId[];

export function isIntegrationClientId(value: string): value is IntegrationClientId {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_CLIENTS, value);
}
