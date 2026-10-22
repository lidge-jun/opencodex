export const CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS = Object.freeze([
  "ASDF_DATA_DIR",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "MISE_DATA_DIR",
  "NODENV_ROOT",
  "NVS_HOME",
  "NVS_NODE_PATH",
  "N_PREFIX",
  "NVM_DIR",
  "NVM_HOME",
  "NVM_SYMLINK",
  "PROTO_HOME",
  "SCOOP",
  "SCOOP_GLOBAL",
  "VOLTA_HOME",
]);

export const CODEX_CLI_TRANSPORT_ENV_KEYS = Object.freeze([
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "node_extra_ca_certs",
]);

/** Preserve spelling, aliases and empty values before Bun loads project dotenv. */
export function captureCodexCliTransportEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    CODEX_CLI_TRANSPORT_ENV_KEYS.includes(name.toLowerCase()) && typeof value === "string"));
}

/**
 * Detect the read-only Codex CLI updater inspection namespace before Bun loads.
 * Keep this exact and argument-position based: malformed actions still inherit
 * the zero-effect launcher contract and are rejected by the Bun-side parser.
 */
export function isCodexCliUpdateInspectionArgv(argv) {
  // Bun consumes every internal launch-proof argument before ordinary command
  // parsing. Classify the same effective argv here so a user-supplied invalid
  // proof cannot hide this namespace from the pre-Bun zero-effect policy.
  const args = argv.slice(2).filter(value => !value.startsWith("--ocx-internal-launch-proof="));
  return args[0] === "system" && args[1] === "codex-cli-update";
}

/** Serialized OCX_NODE_LAUNCH_CONTEXT ceiling; src/cli/launcher-context.ts refuses above it. */
export const NODE_LAUNCH_CONTEXT_MAX_CHARS = 64 * 1024;

/**
 * The HOME/NODE_PATH seeds the update inspection's modeled Node lookup needs,
 * bounded against the launch-context budget. They are POSIX-only: a Windows
 * inspection never models the global lookup, so the seeds are not sent at all
 * (and their env copies stay inherited for the child's own use). If carrying
 * them would push the serialized context past the reader's limit they are
 * dropped instead of taking the whole snapshot down with them — absent seeds
 * leave only the global lane unverifiable, which fails the content
 * observation closed while the selection context survives.
 */
export function codexCliInspectionLookupSeeds(platform, home, nodePath, serializedContextChars) {
  if (platform === "win32" || serializedContextChars > NODE_LAUNCH_CONTEXT_MAX_CHARS) {
    return { home: null, nodePath: null };
  }
  return { home: home ?? null, nodePath: nodePath ?? null };
}
