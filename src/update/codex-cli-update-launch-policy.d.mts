export const CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS: readonly [
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
];
export function isCodexCliUpdateInspectionArgv(argv: readonly string[]): boolean;
export const NODE_LAUNCH_CONTEXT_MAX_CHARS: number;
export function codexCliInspectionLookupSeeds(
  platform: string,
  home: string | null,
  nodePath: string | null,
  serializedContextChars: number,
): { home: string | null; nodePath: string | null };
export const CODEX_CLI_TRANSPORT_ENV_KEYS: readonly string[];
export function captureCodexCliTransportEnv(env: Readonly<NodeJS.ProcessEnv>): Record<string, string>;
