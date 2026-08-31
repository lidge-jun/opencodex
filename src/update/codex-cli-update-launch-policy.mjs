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
