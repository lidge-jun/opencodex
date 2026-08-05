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
  gajaeConfigPath,
  gajaeHomeDir,
  hermesConfigPath,
  hermesHomeDir,
  kimiConfigPath,
  kimiHomeDir,
  opencodeGlobalConfigPath,
  openclawConfigPath,
  openclawHomeDir,
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
    configPath: (_env = process.env, home = homedir()) => join(home, ".pi", "agent", "models.json"),
    detectDir: (_env = process.env, home = homedir()) => join(home, ".pi"),
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
};

export const INTEGRATION_CLIENT_IDS: readonly IntegrationClientId[] =
  Object.keys(INTEGRATION_CLIENTS) as IntegrationClientId[];

export function isIntegrationClientId(value: string): value is IntegrationClientId {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_CLIENTS, value);
}
